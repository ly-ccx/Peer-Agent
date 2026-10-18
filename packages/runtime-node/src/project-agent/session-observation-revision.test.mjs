import test from 'node:test';import assert from 'node:assert/strict';
import {sessionObservationRevision} from './session-observation-revision.mjs';
import {prepareReplyReport} from './reply-report-facts.mjs';
import {reportedWaitCurrent} from './reported-wait.mjs';
const plan=error=>({runner:{blockedReason:'Verification gate failed',verifierRuns:[{status:'failed',summary:error,failureReason:error,completedAt:'now',verifierRunId:'first'}]}});
test('a new verifier failure is reportable without changing acceptance source; repeated attempts do not invent novelty',()=>{
 const first=plan('verifier_timeout'),same=structuredClone(first), changed=plan('HTTP 400 reasoning_content missing');
 same.runner.verifierRuns[0].completedAt='later';same.runner.verifierRuns[0].verifierRunId='different';
 const revision=sessionObservationRevision(first,'source');assert.equal(sessionObservationRevision(same,'source'),revision);
 assert.notEqual(sessionObservationRevision(changed,'source'),revision);
 const state={sessionId:'s',status:'waiting_agent',sourceRevision:'source',observationRevision:revision};
 const message={id:'reply',kind:'agent_reply',sources:['s'],meta:{sessionStates:[state]}};
 const next={...state,observationRevision:sessionObservationRevision(changed,'source')};
 assert.equal(prepareReplyReport({workspaceId:'w',message:{...message,meta:{sessionStates:[next]}},reportedMessages:[message]}).suppressed,false);
 assert.equal(reportedWaitCurrent({sessionStates:[state]},[next]),false);
 const accepted=structuredClone(first);accepted.resultAcceptance={acceptedAt:'later',acceptedBy:'policy'};
 assert.equal(sessionObservationRevision(accepted,'source'),revision,'acceptance receipt must not invalidate its own reply');
});
