"""Read-only reconciliation; preserves the separate immediate-injection audit result.

Input is the unmodified strict supplemental audit JSON, plus the frozen repository.
Does not invoke production, execute tools, modify raw evidence, or relax N20.
"""
import hashlib
import json
import pathlib
import sys


def read(path):
    return json.loads(pathlib.Path(path).read_text(encoding='utf-8-sig'))


def block(audit):
    prompt = audit['prompt']
    start = '----- BEGIN UNTRUSTED EXPERIENCE DATA -----'
    end = '----- END UNTRUSTED EXPERIENCE DATA -----'
    assert prompt.count(start) == prompt.count(end) == 1
    return prompt.split(start, 1)[1].split(end, 1)[0]


def prompt_valid(audit):
    data = audit['prompt'].encode('utf-8')
    return audit['deliveryStage'] == 'prepared-before-send' and audit['promptBytes'] == len(data) and audit['promptDigest'] == 'sha256:' + hashlib.sha256(data).hexdigest()


source = pathlib.Path(sys.argv[1])
repo = pathlib.Path(sys.argv[2])
strict = read(source)
rows = []
for run in strict['runs']:
    root = pathlib.Path(run['runRoot'])
    if not run.get('rows'):
        if run.get('error'):
            rows.append({'runRoot': str(root), 'error': run['error'], 'contractConformant': False})
        continue
    audits = [read(p) for p in (root / 'bridge/prompt-audits').glob('*.json')]
    experiences = read(root / 'runtime/experiences/experiences.json')['records']
    for original in run['rows']:
        result = {'runRoot': str(root), 'taskId': original['taskId'], 'immediateAuditPassed': original['passed'], 'immediateAuditIssues': original['issues']}
        try:
            recovery = next(a for a in audits if a['runId'] == original['continuationRunId'])
            before = next(a for a in audits if a['runId'] == recovery['roundFacts']['previous']['runId'])
            experience = next(e for e in experiences if e['id'] == original['experienceId'] and e['version'] == original['experienceVersion'])
            checks = {
                'sameLogicalRound': before['roundId'] == recovery['roundId'],
                'differentRun': before['runId'] != recovery['runId'],
                'sameFrozenSelection': before['selection'] == recovery['selection'],
                'sameExperienceBytes': block(before).encode() == block(recovery).encode(),
                'recordWrittenAfterSourcePromptBeforeRecovery': before['createdAt'] < experience['createdAt'] < recovery['createdAt'],
                'bothPromptDigestsValid': prompt_valid(before) and prompt_valid(recovery),
                'otherImmediateChecksPassed': set(original['issues']).issubset({'failed experience selected', 'complete failed experience in prompt'}),
            }
            later = sorted((a for a in audits if a['missionId'] == recovery['missionId'] and a['createdAt'] > recovery['createdAt'] and a['roundId'] != before['roundId']), key=lambda a: a['createdAt'])
            new_round = {'status': 'not_observed', 'reason': 'No later new logical round exists in these retained originals.'}
            if later:
                next_audit = later[0]
                data = json.loads(block(next_audit))
                selected = [x for x in next_audit['selection']['selected'] if x['id'] == experience['id'] and x['version'] == experience['version'] and x['source'] == 'execution']
                items = [x for x in data['items'] if x['id'] == experience['id'] and x['version'] == experience['version']]
                new_checks = {
                    'promptDigestValid': prompt_valid(next_audit),
                    'selectedExactIdentity': len(selected) == 1,
                    'fullContentExact': len(items) == 1 and items[0]['content'] == experience['content'],
                    'versionAndContextExact': data['versions'].get(experience['id']) == experience['version'] and data['contextId'] == next_audit['selection']['contextId'],
                    'newSnapshot': next_audit['selection']['contextId'] != before['selection']['contextId'] and next_audit['selection']['repositoryRevision'] > before['selection']['repositoryRevision'],
                }
                new_round = {'status': 'observed' if all(new_checks.values()) else 'failed', 'runId': next_audit['runId'], 'roundId': next_audit['roundId'], 'checks': new_checks}
            result.update({'sourceRunId': before['runId'], 'recoveryRunId': recovery['runId'], 'sameRoundChecks': checks, 'newLogicalRound': new_round, 'contractConformant': all(checks.values()) and new_round['status'] != 'failed'})
        except (KeyError, ValueError, StopIteration, AssertionError) as error:
            result.update({'error': type(error).__name__ + ': ' + str(error), 'contractConformant': False})
        rows.append(result)
contract = repo / 'client-runtime/application/round-experience-service.md'
report = {
    'schemaVersion': 'operator-studio.failed-feedback-freeze-reconciliation/v1',
    'mode': 'read-only-retained-originals',
    'strictImmediateAudit': {'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest(), 'passed': strict['passed']},
    'contract': {'path': 'client-runtime/application/round-experience-service.md', 'sha256': hashlib.sha256(contract.read_bytes()).hexdigest(), 'rule': '同轮恢复不重查、不刷新清单。不同轮才取得新快照。'},
    'rows': rows,
    'eligibleFailedCandidates': strict['eligibleFailedCandidates'],
    'contractConformant': all(x['contractConformant'] for x in rows),
    'newLogicalRoundObservedCount': sum(x.get('newLogicalRound', {}).get('status') == 'observed' for x in rows),
    'interpretation': 'This separately checks existing freeze semantics. It does not change or override the immediate-injection audit failure, full E2E verifier, or N20 gate. No failed candidate means not observed, never proof.',
}
print(json.dumps(report, ensure_ascii=False, indent=2))
sys.exit(0 if report['contractConformant'] else 1)
