const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
let pg;try{pg=require('pg')}catch{}
const url=process.env.TEST_DATABASE_URL;
const tables=['core_confirmation_challenges','core_confirmations','core_approvals','core_print_jobs'];
const migrationPath=path.resolve(__dirname,'../../../backend/storage/migrations/011_print_evidence_binding.sql');

test('V1-CORE-03 migration binds nullable evidence SHA without defaults or backfill',
 {skip:!(pg&&url)&&'NOT RUN - isolated PostgreSQL TEST_DATABASE_URL required',timeout:30000},async()=>{
 const parsed=new URL(url);
 assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));
 assert.match(parsed.pathname,/test/i);
 const sql=fs.readFileSync(migrationPath,'utf8');
 const manifest=fs.readFileSync(path.resolve(__dirname,'../../../backend/storage/migrations.ts'),'utf8');
 assert.match(manifest,/['"]011_print_evidence_binding\.sql['"]/);
 const pool=new pg.Pool({connectionString:url,max:1});
 const db=await pool.connect();
 try{
  await db.query('BEGIN');
  for(const table of tables){
   // Temporary legacy tables shadow public Core tables, so this exercises the
   // actual migration against existing rows without changing the shared schema.
   await db.query(`CREATE TEMP TABLE ${table} (id integer PRIMARY KEY)`);
   await db.query(`INSERT INTO ${table}(id) VALUES(1)`);
  }
  await db.query(sql);
  await db.query(sql); // the registered migration must also remain safe to reapply.
  const rejectsConstraint=async(query,values)=>{
   await db.query('SAVEPOINT invalid_evidence_digest');
   try{await assert.rejects(db.query(query,values),e=>e.code==='23514');}
   finally{
    await db.query('ROLLBACK TO SAVEPOINT invalid_evidence_digest');
    await db.query('RELEASE SAVEPOINT invalid_evidence_digest');
   }
  };
  for(const table of tables){
   const column=(await db.query(
    `SELECT format_type(a.atttypid,a.atttypmod) AS type,a.attnotnull,
            pg_get_expr(d.adbin,d.adrelid) AS default_expression
       FROM pg_attribute a LEFT JOIN pg_attrdef d
         ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=to_regclass($1) AND a.attname='evidence_sha256' AND NOT a.attisdropped`,
    [table])).rows[0];
   assert.deepEqual(column,{type:'character(64)',attnotnull:false,default_expression:null},`${table} nullable with no default`);
   const old=(await db.query(`SELECT evidence_sha256 FROM ${table} WHERE id=1`)).rows[0];
   assert.equal(old.evidence_sha256,null,`${table} legacy record remains unbackfilled`);
   const constraintName=`${table}_evidence_sha256_valid`;
   const constraint=(await db.query(
    'SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid=to_regclass($1) AND conname=$2',
    [table,constraintName])).rows[0];
   assert.match(constraint.definition,/evidence_sha256 IS NULL/i);
   await db.query(`INSERT INTO ${table}(id,evidence_sha256) VALUES(2,$1)`,['a'.repeat(64)]);
   await rejectsConstraint(`INSERT INTO ${table}(id,evidence_sha256) VALUES(3,$1)`,['A'.repeat(64)]);
   await rejectsConstraint(`INSERT INTO ${table}(id,evidence_sha256) VALUES(4,$1)`,['a'.repeat(63)]);
  }
 }finally{
  await db.query('ROLLBACK').catch(()=>{});
  db.release();await pool.end();
 }
});
