import {createHmac,timingSafeEqual} from 'node:crypto';
import type {FastifyPluginAsync} from 'fastify';
import type {SqlPool} from '../storage/database.js';
import {PgStore} from '../storage/database.js';
import {createVerifiedConfirmationPort} from '../core/verified-confirmation-port.js';
import {DomainError} from '../core/model.js';
import type {TrustedPrintEvidencePort} from '../core/print-evidence.js';

/** Simulation ONLY. Never install this route in a real OA runtime. The fixture
 * secret is installed by the server, never read from a webhook body. Production
 * provider signature and button mapping are NOT implemented or implied. */
export interface SyntheticButtonScope {
  kind:'synthetic_fixture';shop_id:string;oa_id:string;fixture_secret:string;
}
type Button={
  synthetic_fixture:true;type:'explicit_button_accept';event_id:string;
  oa_id:string;customer_id:string;conversation_id:string;occurred_at:string;
  challenge_id:string;challenge_token:string;
};
type ChallengeRow={order_id:string;revision:number;request_hash:string;kind:'request'|'quote';
  quote_revision:number|null;generation:string|number;customer_id:string;
  conversation_id:string;expires_at:Date};
const safe=(v:unknown,max:number):v is string=>
  typeof v==='string'&&v.trim()===v&&v.length>0&&v.length<=max;
const failure=(code:string,status:number)=>new DomainError(code,code,status);
const legal=new Set(['synthetic_fixture','type','event_id','oa_id','customer_id',
 'conversation_id','occurred_at','challenge_id','challenge_token']);
function parseButton(raw:Buffer,scope:SyntheticButtonScope):Button{
  let value:unknown;try{value=JSON.parse(raw.toString('utf8'))}catch{throw failure('INVALID_SYNTHETIC_BUTTON',422)}
  if(!value||typeof value!=='object'||Array.isArray(value))
    throw failure('INVALID_SYNTHETIC_BUTTON',422);
  const b=value as Record<string,unknown>;
  if(Object.keys(b).length!==legal.size||Object.keys(b).some(k=>!legal.has(k))||
     b.synthetic_fixture!==true||b.type!=='explicit_button_accept'||
     b.oa_id!==scope.oa_id||!safe(b.event_id,128)||!safe(b.customer_id,128)||
     !safe(b.conversation_id,128)||!safe(b.challenge_id,64)||
     !safe(b.challenge_token,256)||!safe(b.occurred_at,40))
    throw failure('INVALID_SYNTHETIC_BUTTON',422);
  const time=Date.parse(b.occurred_at as string);
  if(!Number.isFinite(time)||Math.abs(Date.now()-time)>5*60*1000)
    throw failure('EXPIRED_SYNTHETIC_BUTTON',409);
  return b as Button;
}
/** Register ONLY when an explicitly installed isolated test fixture is present.
 * No staff/user principal is synthesized; channel identity is the HMAC-authenticated
 * fixture itself. Challenge is fetched from PostgreSQL, never the client order body.
 * The event is committed before AI1 performs its own row-locked confirmation.
 */
export function createSyntheticVerifiedButtonPlugin(
  pool:SqlPool,scope:SyntheticButtonScope,evidence?:TrustedPrintEvidencePort
):FastifyPluginAsync{
  if(scope?.kind!=='synthetic_fixture'||!safe(scope.shop_id,128)||
     !safe(scope.oa_id,128)||!safe(scope.fixture_secret,256)||
     scope.fixture_secret.length<32)
    throw Error('SYNTHETIC_BUTTON_CONFIG_REQUIRED');
  const port=createVerifiedConfirmationPort({store:new PgStore(pool),
    trusted:{shop_id:scope.shop_id,oa_id:scope.oa_id},...(evidence?{evidence}:{})});
  return async app=>{
    app.addContentTypeParser('application/vnd.autoin.synthetic-button+json',
      {parseAs:'buffer'},(_req,buffer,done)=>done(null,buffer));
    app.post('/internal/simulation/verified-button',async(req,reply)=>{
      if(!Buffer.isBuffer(req.body))throw failure('RAW_FIXTURE_REQUIRED',415);
      const signature=req.headers['x-autoin-fixture-hmac'];
      const expected=createHmac('sha256',scope.fixture_secret).update(req.body).digest();
      if(typeof signature!=='string'||!/^[a-f0-9]{64}$/.test(signature)||
         !timingSafeEqual(Buffer.from(signature,'hex'),expected))
        throw failure('FIXTURE_SIGNATURE_REJECTED',403);
      const b=parseButton(req.body,scope);
      const lookup=await pool.query<ChallengeRow>(`
        SELECT c.order_id::text,c.revision,c.request_hash,c.kind,c.quote_revision,
          c.generation::text,c.customer_id,c.conversation_id,c.expires_at
        FROM core_confirmation_challenges c
        JOIN core_orders o ON o.id=c.order_id AND o.shop_id=c.shop_id
        JOIN core_shop_settings s ON s.shop_id=c.shop_id AND s.mode='simulation'
        WHERE c.id=$1::uuid AND c.shop_id=$2 AND c.oa_id=$3
          AND o.customer_id=c.customer_id AND o.conversation_id=c.conversation_id
      `,[b.challenge_id,scope.shop_id,scope.oa_id]);
      const challenge=lookup.rows[0];
      if(!challenge||challenge.customer_id!==b.customer_id||
         challenge.conversation_id!==b.conversation_id)
        throw failure('BUTTON_CUSTOMER_SCOPE_DENIED',403);
      if(new Date(challenge.expires_at).getTime()<=Date.now())
        throw failure('BUTTON_CHALLENGE_EXPIRED',409);
      // The only time confirmation_postback enters storage is AFTER raw HMAC
      // authentication and strict explicit-button parsing in this isolated route.
      const normalized={
        event_id:b.event_id,oa_id:scope.oa_id,customer_id:b.customer_id,
        conversation_id:b.conversation_id,occurred_at:b.occurred_at,
        kind:'unsupported',fixture_verified_explicit_button:true,
        confirmation_postback:{kind:'verified_confirmation_accept',
          challenge_id:b.challenge_id,challenge_token:b.challenge_token}
      };
      const db=new PgStore(pool);
      await db.tx(async tx=>{
        const inserted=await tx.query(`
          INSERT INTO zalo_inbound_events
          (oa_id,event_id,customer_id,conversation_id,occurred_at,payload_json)
          VALUES($1,$2,$3,$4,$5,$6::jsonb)
          ON CONFLICT (oa_id,event_id) DO NOTHING RETURNING event_id
        `,[scope.oa_id,b.event_id,b.customer_id,b.conversation_id,b.occurred_at,
          JSON.stringify(normalized)]);
        if(!inserted.rows.length){
          const existing=await tx.query<{payload_json:unknown}>(`
            SELECT payload_json FROM zalo_inbound_events WHERE oa_id=$1 AND event_id=$2
            FOR UPDATE
          `,[scope.oa_id,b.event_id]);
          const old=existing.rows[0]?.payload_json;
          // Existing normalized event MUST be identical, including token/challenge.
          if(JSON.stringify(old)!==JSON.stringify(normalized)){
            // JSONB reorders keys, so compare structural fields in canonical JSONB.
            const same=await tx.query<{same:boolean}>(`
              SELECT payload_json=$3::jsonb AS same FROM zalo_inbound_events
              WHERE oa_id=$1 AND event_id=$2
            `,[scope.oa_id,b.event_id,JSON.stringify(normalized)]);
            if(same.rows[0]?.same!==true)throw failure('BUTTON_EVENT_REPLAY_CONFLICT',409);
          }
        }
        // Button events are handled by AI1, never sent through AI2 text batching.
        await tx.query(`
          INSERT INTO zalo_process_queue(oa_id,event_id,status,committed_at)
          VALUES($1,$2,'COMMITTED',now()) ON CONFLICT DO NOTHING
        `,[scope.oa_id,b.event_id]);
      });
      const generation=Number(challenge.generation);
      if(!Number.isSafeInteger(generation)||generation<0)
        throw failure('BUTTON_GENERATION_INVALID',409);
      const result=await port.confirm_verified_event({
        order_id:challenge.order_id,expected_revision:challenge.revision,
        request_hash:challenge.request_hash,expected_generation:generation,
        kind:challenge.kind,
        ...(challenge.kind==='quote' && challenge.quote_revision!==null ? {quote_revision:challenge.quote_revision} : {}),
        event_id:b.event_id
      });
      return reply.code(result.status==='confirmed'?201:200)
        .header('Cache-Control','no-store').send(result);
    });
  };
}
