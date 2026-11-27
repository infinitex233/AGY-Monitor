import test from 'node:test';
import assert from 'node:assert/strict';
import {computeDecodeDurationSec, extractContextBreakdown, extractLiveActivity, extractModelSteps, normalizeCachedStep, speedMetric, summarizeSpeed, summarizeTtft} from '../trajectory-metrics.mjs';

function sample({total=12,ttft='2s',stream='10s',output=1100,thinking=100,response=1000,
  thinkingDuration='4s',tools=false,text=true,status='CORTEX_STEP_STATUS_DONE'}={}) {
  const s={status,type:'CORTEX_STEP_TYPE_PLANNER_RESPONSE',metadata:{
    createdAt:'2026-01-01T00:00:00Z',viewableAt:'2026-01-01T00:00:02Z',
    finishedGeneratingAt:new Date(Date.parse('2026-01-01T00:00:00Z')+total*1000).toISOString(),
    modelUsage:{inputTokens:'500',cacheReadTokens:'2000',outputTokens:String(output),thinkingOutputTokens:String(thinking),responseOutputTokens:String(response)},
  },plannerResponse:{response:text?'answer':'',thinkingDuration,toolCalls:tools?[{}]:[]}};
  const gm={stepIndices:[0],chatModel:{timeToFirstToken:ttft,streamingDuration:stream}};
  return {s,gm};
}
function parse(options) {const {s,gm}=sample(options);return extractModelSteps([s],[gm])[0];}

test('text, tools and mixed output all use pure decode TPS (total output / decode duration)',()=>{
  for(const tools of [false,true])for(const text of [false,true]){
    const step=parse({tools,text});
    assert.equal(speedMetric(step).value,1100/10);
    assert.equal(step.speedBasis,'decode');
    assert.equal(step.speedSampleEligible,true);
  }
});
test('streaming and thinking phase timers cannot alter pure decode TPS',()=>{
  for(const stream of ['0.001s','0.01s','1s','10s',undefined]){
    for(const thinkingDuration of ['0.01s','9.999s',undefined]){
      const step=parse({total:10,ttft:'8s',stream,thinkingDuration,output:300,tools:true,text:false});
      assert.equal(step.totalTokPerSec,150);
      assert.equal(step.ttftSec,8);
    }
  }
});
test('TTFT is the exact native value, never a token-ratio guess or viewable-event substitute',()=>{
  assert.equal(parse({total:20,ttft:'19.9s',thinkingDuration:'19.95s',tools:true,text:false}).ttftSec,19.9);
  const {s,gm}=sample();delete gm.chatModel.timeToFirstToken;
  const step=extractModelSteps([s],[gm])[0];
  assert.equal(step.ttftSec,null);assert.equal(step.viewableDelaySec,2);
  assert.equal(step.speedReason, 'missing_ttft');
  assert.equal(step.totalTokPerSec, null);
  assert.equal(step.decodeDurationSec, null);
  assert.equal(step.speedBasis, 'unavailable');
  assert.equal(speedMetric(step).reason, 'missing_ttft');
  assert.deepEqual(summarizeTtft([step]),{sampleCount:0,avgSec:null});
});
test('zero TTFT is preserved and malformed or negative durations remain unknown',()=>{
  const zero=parse({ttft:'0s'});
  assert.equal(zero.ttftSec,0);
  assert.equal(summarizeTtft([zero]).avgSec,0);
  for(const ttft of ['-1s','12garbage','NaNs','Infinitys',''])assert.equal(parse({ttft}).ttftSec,null);
});
test('short output keeps the same formula but does not bias the mean',()=>{
  const short=parse({output:13,response:13,thinking:0,total:5.015,stream:'0.118s'});
  assert.equal(short.totalTokPerSec,13/3.015);
  assert.equal(short.speedReason,'short_sample');
  assert.equal(summarizeSpeed([short,parse()]).avgTokPerSec,1100/10);
  assert.equal(summarizeSpeed([short]).avgTokPerSec,null);
  assert.equal(parse({output:50}).speedSampleEligible,true);
});
test('sub-half-second whole requests are withheld, never divided by a tiny interval',()=>{
  const tiny=parse({total:.05,output:1000});
  assert.equal(tiny.totalTokPerSec,null);assert.equal(tiny.speedReason,'short_timing');
  assert.equal(speedMetric(tiny).value,null);
  assert.equal(summarizeSpeed([tiny]).sampleCount,0);
  assert.equal(parse({total:.5,output:100,ttft:'0.1s'}).totalTokPerSec,100/(0.5-0.1));
});
test('decode duration requires valid native TTFT and a window of at least 100 ms', () => {
  assert.equal(computeDecodeDurationSec(0.1, 0), 0.1);
  assert.equal(computeDecodeDurationSec(0.5, 0.4), 0.1);
  assert.equal(computeDecodeDurationSec(2.5, 2), 0.5);
  for (const [total, ttft] of [[1, null], [2, -1], [2, NaN], [2, 2.02], [2, 2.005], [0, 0], [Infinity, 1], [2, 1.901]]) {
    assert.equal(computeDecodeDurationSec(total, ttft), null);
  }
});
test('held bursts are excluded while longer windows and brief waits are accepted', () => {
  const held = parse({ total: 7.5, ttft: '7.2s', output: 300 });
  assert.equal(held.speedReason, 'held_burst');
  assert.equal(held.totalTokPerSec, null);
  assert.equal(held.decodeDurationSec, null);
  assert.equal(speedMetric(held).reason, 'held_burst');
  for (const [total, ttft, expected] of [
    [10.5, 8, 120],
    [1.2, 0.4, 375],
    [8.2, 7.2, 300],
    [8.25, 7.25, 300],
    [0.5, 0.4, 3000],
    [2.5, 2, 600],
  ]) {
    const step = parse({ total, ttft: `${ttft}s`, output: 300 });
    assert.equal(step.speedSampleEligible, true);
    assert.ok(Math.abs(speedMetric(step).value - expected) < 1e-9);
  }
});
test('long-wait buffered bursts above 1 s are excluded when exceeding 3x same-model session median', () => {
  const mk = (idx, opts) => {
    const { s, gm } = sample(opts);
    s.metadata.sourceTrajectoryStepInfo = { stepIndex: idx };
    s.metadata.modelUsage.model = 'MODEL_NEON';
    gm.stepIndices = [idx];
    return { s, gm };
  };
  const cases = [
    mk(0, { total: 10.367, ttft: '7.687s', output: 426 }),  // ~159 tok/s (normal)
    mk(1, { total: 13.393, ttft: '10.754s', output: 480 }), // ~182 tok/s (normal)
    mk(2, { total: 24.815, ttft: '22.323s', output: 557 }), // ~224 tok/s, ttft>4*dec, <=3x med -> keep!
    mk(3, { total: 15.183, ttft: '14.117s', output: 1556 }), // ~1460 tok/s, dec=1.066s, ttft>4*dec, >3x med -> held_burst!
    mk(4, { total: 7.0, ttft: '2.0s', output: 3000 }),       // 600 tok/s, >3x med, but ttft<=4*dec -> keep!
  ];
  const steps = extractModelSteps(
    cases.map((c) => c.s),
    cases.map((c) => c.gm)
  );
  assert.equal(steps[0].speedSampleEligible, true);
  assert.equal(steps[1].speedSampleEligible, true);
  assert.equal(steps[2].speedSampleEligible, true);
  assert.equal(steps[3].totalTokPerSec, null);
  assert.equal(steps[3].decodeDurationSec, null);
  assert.equal(steps[3].speedSampleEligible, false);
  assert.equal(steps[3].speedReason, 'held_burst');
  assert.equal(speedMetric(steps[3]).reason, 'held_burst');
  assert.equal(steps[4].speedSampleEligible, true);
  assert.equal(steps[4].totalTokPerSec, 600);
});
test('rates above 10,000 tok/s are excluded', () => {
  const atLimit = parse({ total: 0.7, ttft: '0.5s', output: 2000 });
  const outlier = parse({ total: 0.7, ttft: '0.5s', output: 2001 });
  assert.equal(speedMetric(atLimit).value, 10000);
  assert.equal(outlier.totalTokPerSec, null);
  assert.equal(speedMetric(outlier).reason, 'speed_outlier');
  assert.deepEqual(summarizeSpeed([atLimit, outlier]).excludedReasons, { speed_outlier: 1 });
});
test('speed metrics reconstruct a slim step only when it has valid decode timing', () => {
  const { decodeDurationSec, ...slim } = parse();
  assert.equal(speedMetric(slim).seconds, decodeDurationSec);
  assert.equal(speedMetric({ ...slim, nativeTtftSec: null }).reason, 'missing_ttft');
  assert.equal(speedMetric({ ...slim, totalDurationSec: 2.05 }).reason, 'short_decode');
  assert.equal(speedMetric({ ...slim, totalDurationSec: 2.25 }).reason, 'held_burst');
  assert.equal(speedMetric({ ...slim, outputTokens: 100001 }).reason, 'speed_outlier');
});
test('speed summaries use exact odd and even medians and emit sparse bins', () => {
  const stalled = parse({ output: 100, total: 102 });
  const normal = parse({ output: 100, total: 3 });
  const faster = parse({ output: 200, total: 3 });
  const fastOutlier = parse({ output: 9000, total: 3 });
  const even = summarizeSpeed([fastOutlier, normal, stalled, faster]);
  assert.equal(even.avgTokPerSec, 150);
  assert.equal(even.tokens, 9400);
  assert.equal(even.seconds, 103);
  assert.equal(even.sampleCount, 4);
  assert.equal(even.rateBins[400], 1);
  assert.equal(Object.values(even.rateBins).reduce((sum, count) => sum + count, 0), 4);
  assert.equal(Object.hasOwn(even, 'rates'), false);
  assert.equal(summarizeSpeed([normal, stalled, faster]).avgTokPerSec, 100);
  assert.equal(summarizeSpeed([normal, fastOutlier, faster]).avgTokPerSec, 200);
  assert.equal(summarizeSpeed([parse()]).avgTokPerSec, 110);
});
test('unfinished, missing-completion and reversed-time requests cannot fabricate speed',()=>{
  const {s,gm}=sample();delete s.metadata.finishedGeneratingAt;
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,null);
  assert.equal(parse({total:-1}).totalTokPerSec,null);
  assert.equal(parse({total:0}).totalTokPerSec,null);
  assert.equal(parse({status:'CORTEX_STEP_STATUS_GENERATING'}).totalTokPerSec,null);
});
test('cleared steps with a recorded generation end retain their original decode speed',()=>{
  const {s,gm}=sample({status:'CORTEX_STEP_STATUS_CLEARED'});
  s.metadata.completedAt='2026-01-01T00:04:00Z';
  const [cleared]=extractModelSteps([s],[gm]);
  assert.equal(cleared.totalDurationSec,12);
  assert.equal(cleared.totalTokPerSec,1100/10);
  assert.equal(cleared.isComplete,true);

  for(const status of ['CORTEX_STEP_STATUS_CANCELED','CORTEX_STEP_STATUS_ERROR','CORTEX_STEP_STATUS_GENERATING']){
    assert.equal(extractModelSteps([{...s,status}],[gm])[0].totalTokPerSec,null);
  }
  const [canceled]=extractModelSteps([{...s,status:'CORTEX_STEP_STATUS_CANCELED'}],[gm]);
  assert.equal(speedMetric(canceled).reason,'canceled');
  delete s.metadata.finishedGeneratingAt;
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,null);
  const [checkpoint]=extractModelSteps([{...s,type:'CORTEX_STEP_TYPE_CHECKPOINT'}],[gm]);
  assert.equal(speedMetric(checkpoint).value,null);
  assert.equal(speedMetric(checkpoint).reason,'compaction_timing_unavailable');
  assert.equal(summarizeSpeed([checkpoint,canceled]).sampleCount,0);
});
test('zero output is a real zero; malformed or missing output counts cannot produce rates',()=>{
  const zero=parse({output:0,response:0,thinking:0});
  assert.equal(zero.totalTokPerSec,0);assert.equal(zero.responseTokens,0);
  assert.equal(zero.speedSampleEligible, false);
  assert.equal(zero.speedReason, 'short_sample');
  for(const output of [-1,1.5,NaN,Infinity])assert.equal(parse({output}).totalTokPerSec,null);
  const {s,gm}=sample();delete s.metadata.modelUsage.outputTokens;
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,null);
});
test('missing phase/token breakdown cannot change a valid decode rate',()=>{
  const {s,gm}=sample();delete s.plannerResponse.thinkingDuration;
  delete s.metadata.modelUsage.thinkingOutputTokens;delete s.metadata.modelUsage.responseOutputTokens;
  delete gm.chatModel.streamingDuration;
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,1100/10);
});
test('no rate-dependent cap or formula switch at the former 260 TPS boundary',()=>{
  const a=parse({total:10,output:2590,tools:true}),b=parse({total:10,output:2610,tools:true});
  assert.equal(a.totalTokPerSec,2590/8);assert.equal(b.totalTokPerSec,2610/8);
  assert.equal(a.speedBasis,b.speedBasis);
});
test('legacy cache retains billing but cannot masquerade as current measurements',()=>{
  for(const measurementVersion of [undefined,1,2,3,4,5,6]){
    const old={measurementVersion,inputTokens:500,cacheReadTokens:2000,outputTokens:1100,ttftSec:0.4,totalTokPerSec:55};
    const migrated=normalizeCachedStep(old);
    assert.equal(migrated.outputTokens,1100);assert.equal(migrated.inputTokens,500);
    assert.equal(migrated.ttftSec,null);assert.equal(speedMetric(migrated).value,null);
    assert.equal(speedMetric(migrated).reason,'legacy_cache');
  }
});

test('half-second cutoff uses the original nanoseconds, not rounded epoch milliseconds',()=>{
  const {s,gm}=sample({output:100,ttft:'0.1s'});
  s.metadata.createdAt='2026-01-01T00:00:00.000000001Z';
  s.metadata.finishedGeneratingAt='2026-01-01T00:00:00.500000000Z';
  const below=extractModelSteps([s],[gm])[0];
  assert.equal(below.totalDurationSec,.499999999);assert.equal(below.totalTokPerSec,null);
  s.metadata.finishedGeneratingAt='2026-01-01T00:00:00.500000001Z';
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,100/(0.5-0.1));
  s.metadata.createdAt='2026-01-01T08:00:00.000000001+08:00';
  assert.equal(extractModelSteps([s],[gm])[0].totalTokPerSec,100/(0.5-0.1));
});
test('non-chat generator metadata cannot overwrite matching model timing',()=>{
  const {s,gm}=sample();s.metadata.sourceTrajectoryStepInfo={stepIndex:42};gm.stepIndices=[42];
  const other={stepIndices:[42],tool:{}};
  assert.equal(extractModelSteps([s],[gm,other])[0].nativeTtftSec,2);
  s.metadata.generatorMetadata=[other,{chatModel:{timeToFirstToken:'3s'}}];
  assert.equal(extractModelSteps([s],[gm])[0].nativeTtftSec,3);
});
test('a paginated source step never borrows timing from an unrelated array position',()=>{
  const {s,gm}=sample();s.metadata.sourceTrajectoryStepInfo={stepIndex:42};
  const step=extractModelSteps([s],[gm])[0];
  assert.equal(step.nativeTtftSec, null);
  assert.equal(step.totalTokPerSec, null);
  assert.equal(step.speedReason, 'missing_ttft');
});
test('contradictory native TTFT is preserved but cannot validate TPS or bias the TTFT mean',()=>{
  const bad=parse({total:5,ttft:'9s'});
  assert.equal(bad.nativeTtftSec,9);assert.equal(bad.totalTokPerSec,null);
  assert.equal(bad.speedReason,'inconsistent_timing');
  assert.deepEqual(summarizeTtft([bad,parse()]),{sampleCount:1,avgSec:2});
});
test('unfinished steps do not enter the TTFT mean even when partial metadata includes TTFT',()=>{
  const partial=parse({status:'CORTEX_STEP_STATUS_GENERATING',ttft:'8s'});
  assert.deepEqual(summarizeTtft([partial,parse()]),{sampleCount:1,avgSec:2});
});
test('coercible non-token values cannot silently become zero or one output token',()=>{
  for(const value of [true,false,' ',[],{}]){
    const {s,gm}=sample();s.metadata.modelUsage.outputTokens=value;
    assert.equal(extractModelSteps([s],[gm])[0].speedReason,'invalid_output_tokens');
  }
});
test('visible buffered text and tools with a decode window below 100 ms have no speed',()=>{
  const {s,gm}=sample({output:64,thinking:33,response:31,ttft:'7.0108593s',stream:'0.0045919s'});
  s.metadata.finishedGeneratingAt='2026-01-01T00:00:07.015451200Z';
  delete s.plannerResponse.thinkingDuration;
  const step=extractModelSteps([s],[gm])[0];
  assert.equal(step.totalDurationSec,7.0154512);
  assert.equal(speedMetric(step).value, null);
  assert.equal(speedMetric(step).reason, 'short_decode');
  assert.equal(step.decodeDurationSec, null);
  assert.equal(step.speedBasis, 'unavailable');
});
test('compaction displays a valid rate and retains billing but is excluded from speed/TTFT means',()=>{
  const {s,gm}=sample();s.type='CORTEX_STEP_TYPE_CHECKPOINT';
  const step=extractModelSteps([s],[gm])[0];
  assert.equal(step.outputTokens,1100);assert.equal(speedMetric(step).value,1100/10);
  assert.equal(summarizeSpeed([step]).sampleCount,0);
  assert.equal(summarizeTtft([step]).sampleCount,0);
});

test('extractLiveActivity covers thinking, partial streaming tool args, multi-tool batch progress, waiting, and post-tool reasoning',()=>{
  // 1. Idle conversation returns null
  assert.equal(extractLiveActivity([], false), null);

  // 2. Streaming thinking
  const thinkingStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_GENERATING',
    metadata: { createdAt: '2026-01-01T00:00:10Z' },
    plannerResponse: { thinking: 'Analyzing the telemetry pipeline\nChecking LiveOverviewView layout' },
  };
  const actThink = extractLiveActivity([thinkingStep], true);
  assert.equal(actThink.phase, 'thinking');
  assert.equal(actThink.label, '推理中');
  assert.match(actThink.detail, /Checking LiveOverviewView layout/);

  // 3. Partial JSON tool call while streaming edit_file
  const streamingToolStep = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_STREAMING',
    metadata: { createdAt: '2026-01-01T00:00:12Z' },
    plannerResponse: {
      thinking: 'done thinking',
      toolCalls: [{ name: 'edit_file', argumentsJson: '{"Path":"f:\\\\ppt\\\\sidecars\\\\panel\\\\src\\\\views\\\\LiveOverviewView.js","Replacement":"const a = 1;' }],
    },
  };
  const actPartialTool = extractLiveActivity([streamingToolStep], true);
  assert.equal(actPartialTool.phase, 'tool');
  assert.equal(actPartialTool.label, '修改文件');
  assert.equal(actPartialTool.detail, 'LiveOverviewView.js');

  // 4. Multi-tool batch execution progress ([1/3] -> [2/3] -> post-tool thinking)
  const completedPlannerWith3Tools = {
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: '2026-01-01T00:00:10Z', finishedGeneratingAt: '2026-01-01T00:00:12Z' },
    plannerResponse: {
      toolCalls: [
        { name: 'read_file', argumentsJson: JSON.stringify({ Path: '/repo/plugin.json' }) },
        { name: 'run_command', argumentsJson: JSON.stringify({ CommandLine: 'npm test', toolSummary: '运行单元测试' }) },
        { name: 'edit_file', argumentsJson: JSON.stringify({ Path: '/repo/main.mjs' }) },
      ],
    },
  };
  const toolResult1Done = {
    type: 'CORTEX_STEP_TYPE_GENERIC',
    status: 'CORTEX_STEP_STATUS_DONE',
    metadata: { createdAt: '2026-01-01T00:00:12Z', completedAt: '2026-01-01T00:00:13Z' },
  };
  // After 1st tool finishes, 2nd tool (run_command) is active -> [2/3] 执行命令 · 运行单元测试 (npm test)
  const actBatch2 = extractLiveActivity([completedPlannerWith3Tools, toolResult1Done], true);
  assert.equal(actBatch2.phase, 'tool');
  assert.equal(actBatch2.label, '执行命令');
  assert.equal(actBatch2.stepProgress, '2/3');
  assert.equal(actBatch2.detail, '运行单元测试 (npm test)');

  // When all 3 tools are done and conversation is still running -> shows last completed tool & actual file/command
  const toolResult2Done = { ...toolResult1Done, metadata: { completedAt: '2026-01-01T00:00:15Z' } };
  const toolResult3Done = { ...toolResult1Done, metadata: { completedAt: '2026-01-01T00:00:16Z' } };
  const actPostTools = extractLiveActivity(
    [completedPlannerWith3Tools, toolResult1Done, toolResult2Done, toolResult3Done],
    true
  );
  assert.equal(actPostTools.phase, 'thinking');
  assert.equal(actPostTools.label, '修改文件');
  assert.equal(actPostTools.detail, 'main.mjs');

  // 5. Waiting for user confirmation on command step
  const waitingStep = {
    type: 'CORTEX_STEP_TYPE_RUN_COMMAND',
    status: 'CORTEX_STEP_STATUS_WAITING',
    metadata: {
      createdAt: '2026-01-01T00:00:20Z',
      toolCall: { name: 'run_command', argumentsJson: JSON.stringify({ toolSummary: '安装依赖包' }) },
    },
  };
  const actWait = extractLiveActivity([waitingStep], true);
  assert.equal(actWait.phase, 'waiting');
  assert.equal(actWait.label, '等待确认 · 执行命令');
  assert.equal(actWait.detail, '安装依赖包');

  // 6. transcript.jsonl format (snake_case tool_calls + JSON-encoded string args + DONE status)
  const transcriptPlannerStep = {
    step_index: 7,
    source: 'MODEL',
    type: 'PLANNER_RESPONSE',
    status: 'DONE',
    created_at: '2026-11-10T10:29:49Z',
    thinking: 'Inspecting project files',
    tool_calls: [
      {
        name: 'read_file',
        args: {
          Path: '"f:\\\\ppt\\\\1111\\\\antigravity-usage-monitor\\\\plugin.json"',
        },
      },
      {
        name: 'run_command',
        args: {
          CommandLine: '"Get-ChildItem -Path \\"f:\\\\ppt\\""',
          toolSummary: '"列出插件项目全部源文件"',
        },
      },
    ],
  };
  const transcriptGenericDone = {
    step_index: 8,
    source: 'MODEL',
    type: 'GENERIC',
    status: 'DONE',
    created_at: '2026-11-10T10:29:57Z',
    content: 'Showing lines 1-12 of 12',
  };
  const actTranscript1 = extractLiveActivity([transcriptPlannerStep], true);
  assert.equal(actTranscript1.phase, 'tool');
  assert.equal(actTranscript1.label, '读取文件');
  assert.equal(actTranscript1.stepProgress, '1/2');
  assert.equal(actTranscript1.detail, 'plugin.json');

  const actTranscript2 = extractLiveActivity([transcriptPlannerStep, transcriptGenericDone], true);
  assert.equal(actTranscript2.phase, 'tool');
  assert.equal(actTranscript2.label, '执行命令');
  assert.equal(actTranscript2.stepProgress, '2/2');
  assert.equal(actTranscript2.detail, '列出插件项目全部源文件 (Get-ChildItem -Path "f:\\ppt")');
});

test('extractModelSteps tracks sequential user turns, merges consecutive prompts, marks media, and strips compaction context summaries', () => {
  const mkModelStep = (stepIndex) => ({
    status: 'CORTEX_STEP_STATUS_DONE',
    type: 'CORTEX_STEP_TYPE_PLANNER_RESPONSE',
    metadata: {
      sourceTrajectoryStepInfo: { stepIndex },
      createdAt: '2026-01-01T00:00:00Z',
      finishedGeneratingAt: '2026-01-01T00:00:02Z',
      modelUsage: { inputTokens: '100', cacheReadTokens: '200', outputTokens: '80' },
    },
    plannerResponse: { response: 'ok' },
  });

  const steps = extractModelSteps([
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: { userResponse: '第一轮提问' },
    },
    mkModelStep(1),
    { type: 'CORTEX_STEP_TYPE_VIEW_FILE' },
    mkModelStep(3),
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: { userResponse: '取消前一句' },
    },
    {
      type: 'CORTEX_STEP_TYPE_USER_INPUT',
      userInput: { userResponse: '第二轮补充提问', media: [{}] },
    },
    mkModelStep(7),
    {
      type: 'USER_INPUT',
      content:
        '<CONTEXT_SUMMARY><USER_REQUEST>旧摘要文本</USER_REQUEST></CONTEXT_SUMMARY>\n<USER_REQUEST>\n  第三轮真实提问  \n</USER_REQUEST>\n<ADDITIONAL_METADATA>ignored</ADDITIONAL_METADATA>',
    },
    mkModelStep(9),
  ]);

  assert.equal(steps.length, 4);
  assert.equal(steps[0].turnIndex, 1);
  assert.equal(steps[0].isTurnStart, true);
  assert.equal(steps[0].turnPrompt, '第一轮提问');

  assert.equal(steps[1].turnIndex, 1);
  assert.equal(steps[1].isTurnStart, false);
  assert.equal(steps[1].turnPrompt, undefined);

  assert.equal(steps[2].turnIndex, 2);
  assert.equal(steps[2].isTurnStart, true);
  assert.equal(steps[2].turnPrompt, '取消前一句\n第二轮补充提问 [附图]');

  assert.equal(steps[3].turnIndex, 3);
  assert.equal(steps[3].isTurnStart, true);
  assert.equal(steps[3].turnPrompt, '第三轮真实提问');
});

test('extractContextBreakdown parses split top-level SKILLS, RULES, SUBAGENTS, and PLUGINS groups without dropping tokens', () => {
  const breakdown = extractContextBreakdown({
    chatStartMetadata: {
      contextWindowMetadata: {
        estimatedTokensUsed: 148852,
        maxContextTokens: 256000,
        tokenBreakdown: {
          totalTokens: 148852,
          groups: [
            { type: 'TOKEN_TYPE_SYSTEM_PROMPT', name: 'System Prompt', numTokens: 5505 },
            { type: 'TOKEN_TYPE_MCP_TOOLS', name: 'Mcp Tools', numTokens: 234 },
            { type: 'TOKEN_TYPE_SUBAGENTS', name: 'Subagents', numTokens: 1741 },
            { type: 'TOKEN_TYPE_SKILLS', name: 'Skills', numTokens: 2201 },
            { type: 'TOKEN_TYPE_PLUGINS', name: 'Plugins', numTokens: 1601 },
            { type: 'TOKEN_TYPE_RULES', name: 'Rules', numTokens: 2282 },
            { type: 'TOKEN_TYPE_TOOLS', name: 'Tools', numTokens: 8857 },
            {
              type: 'TOKEN_TYPE_CHAT_MESSAGES',
              name: 'Chat Messages',
              numTokens: 126431,
              children: [
                { name: '2449: CHECKPOINT', numTokens: 5087 },
                { name: '2450: USER_INPUT', numTokens: 281 },
                { name: '2455: SYSTEM_MESSAGE', numTokens: 179 },
                { name: '2502: PLANNER_RESPONSE', numTokens: 15017 },
                { name: '2503: GENERIC', numTokens: 105867 },
              ],
            },
          ],
        },
      },
    },
  });

  assert.ok(breakdown);
  assert.equal(breakdown.skillsTokens, 2201);
  assert.equal(breakdown.userRulesTokens, 2282);
  assert.equal(breakdown.systemPromptTokens, 5505 + 1741 + 1601);
  assert.equal(breakdown.mcpToolsTokens, 234);
  assert.equal(breakdown.systemToolsTokens, 8857);
  assert.equal(breakdown.checkpointTokens, 5087);
  assert.equal(breakdown.userInputTokens, 281);
  assert.equal(breakdown.subagentTokens, 179);
  assert.equal(breakdown.assistantTokens, 15017);
  assert.equal(breakdown.toolResultsTokens, 105867);
  assert.equal(breakdown.messagesTokens, 126431);
  assert.equal(breakdown.totalTokens, 148852);
});
