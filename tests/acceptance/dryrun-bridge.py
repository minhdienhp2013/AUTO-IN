"""AI5 CODE-205: real AI3 Journal + DryRunDriver, never real Windows printing."""
import json
import sys
from pathlib import Path
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT))
from agents.windows.agent import Journal,DryRunDriver,PrintBlocked
def main():
    verb=sys.argv[1]
    if verb=='probe':
        assert callable(Journal) and callable(DryRunDriver)
        print('AI3_JOURNAL_AND_DRYRUN_IMPORTED')
        return
    if verb not in ('begin','send','recover') or len(sys.argv)!=3: raise SystemExit('Only begin/send/recover allowed')
    job=json.loads(sys.stdin.read())
    if job.get('mode')!='simulation' or job.get('printer_id')!='RMP7000':
        raise PrintBlocked('Non-simulation or unexpected printer')
    journal=Journal(Path(sys.argv[2]))
    try:
        if verb=='begin':
            journal.begin(job)
            print(json.dumps({'state':'BOUNDARY','job_id':job['job_id']}))
        elif verb=='recover':
            prior=journal.get(job['job_id'])
            if not prior or prior['state'] not in ('BOUNDARY','ARMED','DRIVER_CALLED'):
                raise PrintBlocked('Nothing uncertain to recover')
            journal.state(job['job_id'],'UNKNOWN',{'evidence_kind':'agent_uncertain',
                'reason':'synthetic_crash_boundary_no_auto_retry'})
            print(json.dumps({'state':'UNKNOWN','job_id':job['job_id'],'driver_calls':0}))
        else:
            prior=journal.get(job['job_id'])
            if not prior or prior['state']!='BOUNDARY': raise PrintBlocked('Journal must precede driver')
            journal.state(job['job_id'],'DRIVER_CALLED')
            output=DryRunDriver().send(job)
            if output.get('mode')!='simulation' or output.get('evidence_kind')!='simulated':
                raise PrintBlocked('Physical evidence forbidden')
            journal.state(job['job_id'],'SIMULATED_DONE',output)
            print(json.dumps(output))
    finally: journal.close()
if __name__=='__main__': main()
