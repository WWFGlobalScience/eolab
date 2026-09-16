import assert from "node:assert/strict";
import test from "node:test";
import { ProcessingApiClient } from "../../src/processing/api.js";
import { calculationIntent } from "../../src/processing/calculation-session.js";
import { performanceDescription } from "../../src/processing/calculation-performance.js";

const intent={source:{collectionId:"r",itemId:"r1",label:"Raster"},area:{kind:"wholeRaster"},calculations:[{label:"Mean",expression:"mean(a)"}]};
const execution={targetChunkPixels:65536,readWidth:512,readHeight:128,evaluationWidth:512,evaluationHeight:128,readWindows:1};
const grid={width:512,height:128,crs:"EPSG:4326",dtype:"float32",transform:[1,0,0,0,-1,90],nativeBlocks:4,decodedBytes:262144,execution};
const plan={planId:"P".repeat(32),operation:"raster.aggregate.v1",expiresAt:"2099-01-01T00:00:00Z",grid};

test("warm-process metadata is validated and distinguishes readiness from repeated operation work", async()=>{
    const process={readyWaitSeconds:0,operationSeconds:.2,overheadSeconds:.01,reusedProcess:true};
    const timing={reservationSeconds:.01,preparationSeconds:.01,nativeProcessSeconds:.21,finalizationSeconds:.01,process};
    for(const value of [process,{...process,readyWaitSeconds:-1},{...process,operationSeconds:".2"},{...process,reusedProcess:"yes"}]){
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:{...plan,timing:{...timing,process:value}}));
        if(value===process)await client.planCalculation(intent);
        else await assert.rejects(()=>client.planCalculation(intent),/invalid/);
    }
    const stages={beforePlanningSeconds:0,planningSeconds:.25,beforeSubmissionSeconds:0,submissionSeconds:.1,afterSubmissionSeconds:2,serverPlan:timing};
    const job={result:{executionTiming:{queueSeconds:.01,preparationSeconds:.01,nativeProcessSeconds:.21,publicationSeconds:.01,process}}};
    const text=performanceDescription(job,2.35,stages).join(" ");
    assert.match(text,/Planning process: reused/);
    assert.match(text,/Calculation process: reused/);
    assert.match(text,/Readiness wait \(including any startup\): 0.000 s; operation: 0.200 s/);
    assert.match(text,/Prewarming completed before this request is excluded/);
    assert.doesNotMatch(performanceDescription(job,2.1,{...stages,planReused:true}).join(" "),/Planning process:/);
});

test("stage metrics accept legacy absence and reject malformed durations at the API boundary",async()=>{
    for(const timing of [undefined,null,{reservationSeconds:0,preparationSeconds:.1,nativeProcessSeconds:1,finalizationSeconds:.2},{reservationSeconds:-1},{nativeProcessSeconds:"1"}]){
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:{...plan,timing}));
        if(timing==null||timing.reservationSeconds===0)await client.planCalculation(intent);
        else await assert.rejects(()=>client.planCalculation(intent),/stage timings/);
    }
    const job={jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",progress:{phase:"ready"},
        result:{url:`/api/processing/jobs/${"J".repeat(32)}/result`,provenanceUrl:`/api/processing/jobs/${"J".repeat(32)}/provenance`,rows:[{label:"Mean",expression:"mean(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]}};
    for(const executionTiming of [undefined,{queueSeconds:.5,preparationSeconds:.1,nativeProcessSeconds:1,publicationSeconds:.1},{queueSeconds:-1}]){
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:{...job,result:{...job.result,executionTiming}}));
        if(executionTiming?.queueSeconds===-1)await assert.rejects(()=>client.getJob(job.jobId),/stage timings/);
        else await client.getJob(job.jobId);
    }
    const invalid=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:{...job,result:{...job.result,queuedToReadySeconds:-1}}));
    await assert.rejects(()=>invalid.getJob(job.jobId),/stage timings/);
});

test("stage presentation labels nested measurements and residual estimates without mixing clock origins",()=>{
    const text=performanceDescription({result:{queuedToReadySeconds:2,executionTiming:{queueSeconds:.5,preparationSeconds:.1,nativeProcessSeconds:1,publicationSeconds:.1}}},5,
        {beforePlanningSeconds:.7,planningSeconds:1.2,beforeSubmissionSeconds:0,submissionSeconds:.3,afterSubmissionSeconds:2.8}).join(" ");
    assert.match(text,/Queue wait: 0.500 s/);
    assert.match(text,/Submission admission \+ result delivery \(estimated remainder\): 1.100 s/);
    assert.match(text,/do not add the two groups/);
    const legacy=performanceDescription({result:{}},undefined).join(" ");
    assert.match(legacy,/Total wait unavailable/);assert.doesNotMatch(legacy,/Queue wait:/);
});

test("API transmits opt-in batch tuning and keeps omitted legacy requests compatible",async()=>{
    const bodies=[];
    const api=new ProcessingApiClient(async(path,options)=>{
        if(path.endsWith("/jobs"))return Response.json({jobs:[]});
        bodies.push(JSON.parse(options.body));return Response.json(plan);
    });
    await api.planCalculation(calculationIntent({...intent,targetChunkPixels:65536}));
    await api.planCalculation(calculationIntent(intent));
    assert.equal(bodies[0].targetChunkPixels,65536);
    assert.equal(Object.hasOwn(bodies[1],"targetChunkPixels"),false);
    for(const bad of [0,-1,4194305,1.5,"65536",true]){
        assert.throws(()=>calculationIntent({...intent,targetChunkPixels:bad}),/Batch size/);
    }
});

test("API rejects corrupt execution metadata and durable timing results",async()=>{
    const api=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:
        {...plan,grid:{...grid,execution:{...execution,evaluationWidth:513}}}));
    await assert.rejects(()=>api.planCalculation(intent),/batch dimensions/);
    const result={url:`/api/processing/jobs/${"J".repeat(32)}/result`,provenanceUrl:`/api/processing/jobs/${"J".repeat(32)}/provenance`,rows:[{label:"Mean",expression:"mean(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]};
    const metrics={execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,readSeconds:1,calculationSeconds:2,resultWriteSeconds:.1,kernelSeconds:4};
    for(const performance of [null,metrics,{...metrics,readSeconds:-1},{...metrics,readWindows:2}]){
        const client=new ProcessingApiClient(async path=>Response.json(path.endsWith("/jobs")?{jobs:[]}:
            {jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",grid,progress:{phase:"ready"},result:{...result,performance}}));
        if(performance===null||performance===metrics)assert.ok(await client.getJob("J".repeat(32)));
        else await assert.rejects(()=>client.getJob("J".repeat(32)),/performance measurements/);
    }
});

test("detailed kernel stages remain optional and validate every measured field", async () => {
    const stages = {sourceSetupSeconds:.1,selectionSetupSeconds:.2,groundAreaSetupSeconds:0,gridCheckSeconds:.1,
        selectionMaskSeconds:1.5,areaWeightsSeconds:0,reductionSeconds:.2};
    const metrics = {execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,readSeconds:.5,calculationSeconds:2,resultWriteSeconds:.1,kernelSeconds:3};
    const result = {url:`/api/processing/jobs/JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ/result`,provenanceUrl:`/api/processing/jobs/JJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJJ/provenance`,
        rows:[{label:"Sum",expression:"sum(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]};
    for (const value of [undefined, null, stages, ...Object.keys(stages).map(key => ({...stages,[key]:-1})), {...stages,reductionSeconds:".2"}]) {
        const api = new ProcessingApiClient(async path => Response.json(path.endsWith("/jobs") ? {jobs:[]} :
            {jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",grid,progress:{phase:"ready"},
                result:{...result,performance:{...metrics,stages:value}}}));
        if (value == null || value === stages) await api.getJob("J".repeat(32));
        else await assert.rejects(() => api.getJob("J".repeat(32)), /stage timings/);
    }
    const text = performanceDescription({result:{performance:{...metrics,stages}}},3).join(" ");
    assert.match(text, /polygon selection masks: 1.500 s/);
    assert.match(text, /formula evaluation and reductions: 0.200 s/);
    assert.match(text, /tile preparation and loop overhead \(remainder\): 0.300 s/);
    assert.match(text, /Other kernel work \(remainder\): 0.000 s/);
    assert.match(text, /do not add them again/);
    assert.match(performanceDescription({result:{performance:metrics}}).join(" "), /Detailed kernel stages were not recorded/);
});


test("polygon mask breakdown is optional, validated and displayed as nested timings", async () => {
    const breakdown = {featureReadingSeconds:.8,projectionSeconds:.3,rasterizationSeconds:.2};
    const stages = {sourceSetupSeconds:.1,selectionSetupSeconds:.2,groundAreaSetupSeconds:0,
        gridCheckSeconds:0,selectionMaskSeconds:1.5,areaWeightsSeconds:0,reductionSeconds:.2};
    const metrics = {execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,
        readSeconds:.5,calculationSeconds:2,resultWriteSeconds:.1,kernelSeconds:3};
    const result = {url:`/api/processing/jobs/${"J".repeat(32)}/result`,
        provenanceUrl:`/api/processing/jobs/${"J".repeat(32)}/provenance`,
        rows:[{label:"Sum",expression:"sum(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]};
    const bad = Object.keys(breakdown).flatMap(key =>
        [-1, "1", null].map(value => ({...breakdown,[key]:value})));
    for (const value of [undefined, null, breakdown, ...bad, {}]) {
        const performance = {...metrics,stages:{...stages,selectionMaskBreakdown:value}};
        const api = new ProcessingApiClient(async () => Response.json({
            jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",grid,
            progress:{phase:"ready"},result:{...result,performance},
        }));
        if (value == null || value === breakdown) await api.getJob("J".repeat(32));
        else await assert.rejects(() => api.getJob("J".repeat(32)), /stage timings/);
    }
    const text = performanceDescription({result:{performance:{...metrics,
        stages:{...stages,selectionMaskBreakdown:breakdown}}}}).join(" ");
    assert.match(text, /feature reading: 0.800 s; projection: 0.300 s; rasterization: 0.200 s/);
    assert.match(text, /mask allocation, union, application and overhead \(remainder\): 0.200 s/);
    assert.match(text, /already included in polygon selection masks/);
    assert.match(performanceDescription({result:{performance:{...metrics,stages}}}).join(" "),
        /mask-stage breakdown was not recorded/);
});

test("temporary mask timings distinguish preparation from reads", async () => {
    const stages = {sourceSetupSeconds:.1,selectionSetupSeconds:.2,groundAreaSetupSeconds:0,
        gridCheckSeconds:0,selectionMaskSeconds:.05,maskPreparationSeconds:1.2,
        maskReadSeconds:.04,areaWeightsSeconds:0,reductionSeconds:.1};
    const performance = {execution,readWindows:1,evaluationTiles:1,reducerUpdates:1,
        readSeconds:.3,calculationSeconds:.2,resultWriteSeconds:0,kernelSeconds:2,stages};
    const result = {url:`/api/processing/jobs/${"J".repeat(32)}/result`,
        provenanceUrl:`/api/processing/jobs/${"J".repeat(32)}/provenance`,
        rows:[{label:"Sum",expression:"sum(a)",state:"ok",value:"1",valueType:"float",aggregates:[]}]};
    for (const field of ["maskPreparationSeconds", "maskReadSeconds"]) {
        for (const value of [0, null, undefined, -1, "1"]) {
            const api = new ProcessingApiClient(async () => Response.json({
                jobId:"J".repeat(32),operation:"raster.aggregate.v1",status:"ready",grid,
                progress:{phase:"ready"},result:{...result,performance:{...performance,
                    stages:{...stages,[field]:value}}}
            }));
            if (value == null || value === 0) await api.getJob("J".repeat(32));
            else await assert.rejects(() => api.getJob("J".repeat(32)), /stage timings/);
        }
    }
    const text = performanceDescription({result:{performance}}).join(" ");
    assert.match(text, /Temporary polygon mask preparation: 1.200 s/);
    assert.match(text, /Mask window reads: 0.040 s/);
    assert.doesNotMatch(text, /mask-stage breakdown was not recorded/);
});
