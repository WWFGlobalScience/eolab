import test from "node:test";
import assert from "node:assert/strict";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RasterSeriesController } from "../../src/raster/series.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";

/** @param {number} west Longitude. @return {Object} Valid sampling box. */
const box = west => ({kind:"selectedArea",selectedBounds:{west,south:0,east:west+1,north:1}});
/** @param {string} id Catalog item ID. @return {Object} Retained raster snapshot. */
const source = id => ({key:id,label:"Raster "+id,item:{collection:"catalog",id},visible:true});
/** @return {Promise<void>} Drain queued lifecycle callbacks. */
const flush = async () => { for (let i=0;i<120;i++) await Promise.resolve(); };
/** @return {{promise:Promise,resolve:Function,reject:Function}} Controllable transport response. */
const deferred = () => { let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject}; };

/** Exercise independent calculation requests and their shared observer against a controlled Processing API.
 * @param {Object} [overrides={}] API fault injection.
 * @param {Map} [data=new Map()] Saved recovery record.
 * @return {Object} Controllers, captured requests and explicit clock/job completion.
 */
function fixture(overrides = {}, data = new Map()) {
    const requests=[],plans=new Map(),server=new Map(),timers=new Map();let serial=0,time=0;
    const clock={setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay});return id;},clearTimeout(id){timers.delete(id);}};
    const grid={nativeBlocks:1,decodedBytes:100,width:10,height:10,crs:"EPSG:4326"};
    const api={
        validateCalculation:async formulas=>{requests.push(["validate",formulas]);return {valid:true};},
        planCalculation:async intent=>{const planId=String(++serial).padStart(32,"0");requests.push(["plan",intent]);plans.set(planId,intent);return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"};},
        discardPlan:async id=>{requests.push(["discard",id]);},
        submitCalculation:async submission=>{
            requests.push(["submit",submission]);
            if(server.has(submission.planId))return server.get(submission.planId);
            const intent=plans.get(submission.planId);
            const job={jobId:submission.planId,operation:"raster.aggregate.v1",status:"running",progress:{phase:"calculating",completedBlocks:0,totalBlocks:1},grid,
                calculations:intent.calculations,sources:{a:intent.source},result:null};
            server.set(job.jobId,job);return job;
        },
        listJobs:async()=>[...server.values()],getJob:async id=>server.get(id),
        cancelJob:async id=>{requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job;},
        ...overrides,
    };
    const storage=new CalculationSessionStorage({get length(){return data.size;},key:index=>[...data.keys()][index]??null,
        getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const jobs=new ProcessingJobs(api,clock);
    const calculationRequests=new CalculationRequests({api,jobs,storage,now:()=>time,requestId:()=>"request-"+String(++serial).padStart(16,"0")});
    const area=new RasterSeriesCalculations({api,requests:calculationRequests,clock,now:()=>time});
    const view={bind(actions){this.actions=actions;},render(state){this.state=state;},downloadCsv(csv){this.csv=csv;}};
    const controller=new RasterSeriesController({view,areaStatistics:area,samplePoint:async()=>({inBounds:true,value:1}),onClose(){},onEditArea(){}});
    controller.updateAvailableRasters([source("1"),source("2")]); controller.setArea(box(0),"First box");
    const tick=async()=>{for(const[id,t]of [...timers])if(t.delay===700){timers.delete(id);t.fn();}await flush();};
    const finish=async(status="ready",cacheHit=false,itemId=null)=>{
        const old=[...server.values()].find(job=>["running","cancelling","queued"].includes(job.status) && (!itemId || job.sources.a.itemId===itemId));
        assert.ok(old,"an active job exists");
        time+=100;
        server.set(old.jobId,{...old,status,result:status==="ready"?{cacheHit,rows:old.calculations.map((row,i)=>({...row,value:i?"22":"-123.4567890123456789",unit:row.expression.startsWith("areaha")?"ha":null,state:"ok",valueType:"float",aggregates:[]}))}:null,error:status==="failed"?{detail:"Raster unavailable"}:null});
        await jobs.refresh();await flush();return old.jobId;
    };
    const open=async()=>{controller.setMode("area");controller.updateSamplingForPanelVisibility(true);await tick();};
    const close=()=>{area.destroy();calculationRequests.destroy();jobs.destroy();};
    return {api,calculationRequests,jobs,storage,data,area,controller,view,requests,plans,server,grid,tick,finish,open,close,elapse:ms=>{time+=ms;}};
}

test("formulas share one job per source, retain exact scalar/unit CSV, and presentation edits do not recalculate",async()=>{
    const h=fixture();h.controller.addFormula("area");await h.open();
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    assert.equal(h.requests.find(([k])=>k==="plan")[1].calculations.length,2);
    await h.finish();await h.finish("ready",true);
    assert.equal(h.area.complete,true);
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    const before=h.requests.length;
    h.view.actions.onOrder("name","reverse");
    h.view.actions.onChartType("scatter");
    h.controller.editFormula(1,{label:"Renamed"});
    h.view.actions.onAddPlot();
    h.view.actions.onStatisticDisplay(2, {plotId:2});
    h.view.actions.onPlotScale(2,"log");
    h.view.actions.onStatisticDisplay(1, {visible:false});
    assert.deepEqual(h.view.state.plots,[{id:1,scale:"linear"},{id:2,scale:"log"}]);
    assert.deepEqual(h.view.state.statistics.map(row=>[row.id,row.visible,row.plotId,row.styleIndex]),[[1,false,1,0],[2,true,2,1]]);
    assert.deepEqual(h.view.state.statistics[1].rows.map(row=>[row.rawValue,row.unit]),[["22","ha"],["22","ha"]]);
    assert.equal(h.view.state.rows.length,4,"table retains hidden statistics");
    h.view.actions.onRemovePlot(2);
    h.view.actions.onRemovePlot(1);
    assert.deepEqual(h.view.state.plots,[{id:1,scale:"linear"}]);
    assert.equal(h.view.state.statistics[1].plotId,1);
    const csv=h.controller.exportCsv();
    assert.match(csv,/"-123.4567890123456789"/);
    assert.match(csv,/"Renamed","mean\(a\)"/);
    assert.match(csv,/"area"/);
    assert.match(csv,/"job_id"/);
    assert.equal(h.requests.length,before);
    h.close();
});

test("large stacks get one confirmation; cached whole-raster plans need none",async()=>{
    const h=fixture();h.controller.chooseArea("whole");await h.open();
    assert.equal(h.area.confirmation,true);
    assert.equal(h.requests.filter(([k])=>k==="submit").length,0);
    await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
    assert.equal(h.area.confirmation,false);assert.equal(h.area.complete,true);
    h.close();
    const cached=fixture();const original=cached.api.planCalculation;
    cached.api.planCalculation=async intent=>({...await original(intent),cacheHit:true});
    cached.controller.chooseArea("whole");await cached.open();await cached.finish("ready",true);await cached.finish("ready",true);
    assert.equal(cached.area.complete,true);assert.equal(cached.area.confirmation,false);cached.close();
});

test("automatic work budget covers the stack, not just each individual raster",async()=>{
    const h=fixture();h.grid.nativeBlocks=80;await h.open();await h.finish();
    assert.equal(h.area.confirmation,true);
    assert.equal(h.area.results.size,1);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,1);
    await h.area.calculateRemainingRasters();await flush();await h.finish();
    assert.equal(h.area.complete,true);h.close();
});

test("rapid area changes cancel submitted work and never mix old-area rows",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");await h.tick();
    assert.ok(h.view.state.previousRows);assert.equal(h.view.state.rows.some(row=>row.state==="value"),false);
    h.controller.setArea(box(20),"Third");await h.tick();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");await flush();
    const planned=h.requests.filter(([kind])=>kind==="plan").at(-1)[1];
    assert.equal(planned.area.selectedBounds.west,20);
    await h.finish();await h.finish();
    assert.equal(h.area.results.size,2);
    for(const result of h.area.results.values())assert.equal(result.calculationInputs.area.selectedBounds.west,20);
    h.close();
});

test("leaving area mode drops the pending stack and waits for acknowledged cancellation",async()=>{
    const h=fixture();await h.open();h.controller.setMode("pixel");await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    assert.equal(h.area.results.size,0);h.close();
});

test("per-raster failure leaves a gap and proceeds to the next raster",async()=>{
    const h=fixture();await h.open();await h.finish("failed");await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.view.state.rows[0].state,"error");
    assert.equal(h.view.state.rows[1].state,"value");
    assert.match(h.controller.exportCsv(),/Raster unavailable/);h.close();
});

test("summary and series submit independently without receiving each other's results",async()=>{
    const h=fixture();const snapshots=[];
    const summary=h.calculationRequests.createClient("summary",state=>{snapshots.push(state);if(state.isIdle&&state.plan)summary.submit(state.plan.planId);});
    await h.open();
    summary.prepare({source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Mean",expression:"mean(a)"}]});
    await flush();
    assert.equal(h.server.size,3,"all three submissions precede any result");
    await h.finish("ready",false,"summary");
    assert.ok(snapshots.every(state=>!state.completedJob||state.completedJob.sources.a.itemId==="summary"));
    assert.equal(h.area.results.size,0);
    await h.finish("ready",false,"2");
    assert.deepEqual(h.view.state.rows.map(row=>row.state),["waiting","value"]);
    await h.finish();assert.equal(h.area.complete,true);h.close();
});

test("obsolete plan responses are released and never submitted",async()=>{
    const h=fixture();const gate=deferred(),original=h.api.planCalculation;
    h.api.planCalculation=async intent=>{const plan=await original(intent);if(intent.area.selectedBounds.west===0)await gate.promise;return plan;};
    await h.open();h.controller.setArea(box(30),"New");await h.tick();gate.resolve();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="discard").length,4);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    for(const [id] of h.server) assert.equal(h.plans.get(id).area.selectedBounds.west,30);
    h.close();
});

test("uncertain submissions keep the original key and cannot leak into summary recovery",async()=>{
    const h=fixture();const submit=h.api.submitCalculation;let lost=true;
    h.api.submitCalculation=async input=>{const job=await submit(input);if(lost){lost=false;throw Error("Connection lost");}return job;};
    await h.open();
    assert.equal(h.area.needsRecovery,true);
    const saved=h.storage.forClient("raster-series:0").read();
    assert.equal(saved.context.client,"raster-series");
    const observed=[];
    h.calculationRequests.createClient("summary",state=>observed.push(state));
    await h.area.retryInterruptedCalculations();await flush();
    const submissions=h.requests.filter(([kind])=>kind==="submit");
    assert.equal(submissions.length,3);assert.deepEqual(submissions[0][1],submissions[2][1]);
    assert.ok(observed.every(state=>!state.unfinishedCalculation));
    await h.finish();await h.finish();
    assert.equal(h.area.complete,true);
    assert.equal(h.area.results.size,2);
    const recoveredResult=[...h.area.results.values()].find(result=>result.job.jobId===saved.pending.planId);
    assert.doesNotMatch(recoveredResult.performanceLines.join(" "),/Planning round trip:/,"lost submission response has no complete timing trace");
    h.close();
});

test("reload cancels every saved series job without restarting the stack or summary",async()=>{
    const h=fixture();await h.open();
    const originals=[...h.server.values()];h.close();
    const recovered=fixture({},h.data);
    for(const job of originals)recovered.server.set(job.jobId,job);
    const summary=recovered.calculationRequests.createClient("summary",()=>{});
    assert.equal(summary.snapshot.unfinishedCalculation,null);
    await recovered.area.recoverAndCancelPreviousSeriesCalculations();await flush();
    assert.equal(recovered.requests.filter(([kind])=>kind==="cancel").length,2);
    await recovered.finish("cancelled");await recovered.finish("cancelled");
    assert.equal(recovered.requests.filter(([kind])=>kind==="submit").length,0);
    assert.deepEqual(recovered.storage.savedClientNames(),[]);recovered.close();
});

test("catalog predicates and annotation uploads remain exact per-raster inputs",async()=>{
    for (const area of [{kind:"catalogSelection",catalogSelection:CATALOG_SELECTION},
        {kind:"polygonArea",polygonArea:{id:"a".repeat(32),sha256:"b".repeat(64)}}]) {
        const h=fixture();h.controller.setArea(area,"Selected polygons");await h.open();
        assert.equal(h.area.confirmation,true);
        await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
        for(const [,intent]of h.requests.filter(([kind])=>kind==="plan"))assert.deepEqual(intent.area,area);
        assert.equal(h.area.complete,true);h.close();
    }
});

test("inline cached completions retain all source positions without queuing extra jobs",async()=>{
    const h=fixture(),plan=h.api.planCalculation,submit=h.api.submitCalculation;
    h.api.planCalculation=async intent=>({...await plan(intent),cacheHit:true});
    h.api.submitCalculation=async input=>{
        const job=await submit(input);
        const ready={...job,status:"ready",result:{cacheHit:true,rows:job.calculations.map(row=>({...row,value:"0",state:"ok",valueType:"float",aggregates:[]}))}};
        h.server.set(job.jobId,ready);return ready;
    };
    h.controller.chooseArea("whole");await h.open();await flush();
    assert.equal(h.area.complete,true);
    assert.deepEqual(h.view.state.rows.map(row=>row.value),[0,0]);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);h.close();
});

test("formula validation and five-formula limit apply before any raster plan",async()=>{
    const h=fixture({validateCalculation:async()=>{throw Error("Unknown function bad");}});
    h.controller.editFormula(1,{expression:"bad(a)"});
    for(let i=0;i<8;i++)h.controller.addFormula("mean");
    assert.equal(h.controller.formulas.length,5);
    await h.open();
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),[0,1,2,3,4]);
    h.controller.removeFormula(2);h.controller.addFormula("sum");
    assert.equal(h.controller.formulas.at(-1).id,6,"formula identities can exceed the number of available styles");
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),[0,2,3,4,1],"reuse the removed formula's style without changing the others");
    h.controller.addFormula("mean");
    assert.equal(h.controller.formulas.length,5,"a sixth active formula is not accepted");
    await h.tick();
    assert.match(h.view.state.message,/Unknown function bad/);
    assert.equal(h.requests.filter(([kind])=>kind==="plan").length,0);h.close();
});

test("closing and reopening a completed area plot preserves its result and completion message",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    const count=h.requests.length;
    h.controller.updateSamplingForPanelVisibility(false);h.controller.updateSamplingForPanelVisibility(true);await h.tick();
    assert.match(h.view.state.message,/Raster series complete/);
    assert.equal(h.requests.length,count);h.close();
});

test("one queued caller can replace and cancel its request without cancelling its peer",async()=>{
    const h=fixture();await h.open();
    const summary=h.calculationRequests.createClient("summary",()=>{});
    const intent={source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Sum",expression:"sum(a)"}]};
    summary.prepare(intent);summary.prepare({...intent,area:box(10)});summary.stop();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,0);
    await h.finish();await h.finish();
    assert.ok([...h.server.values()].every(job=>job.sources.a.itemId!=="summary"));
    assert.equal(h.area.complete,true);h.close();
});

test("all statistics keep identities and raster positions through out-of-order results and new areas",async()=>{
    const h=fixture();h.controller.addFormula("min");h.controller.addFormula("max");await h.open();
    await h.finish("ready",false,"2");
    for(const statistic of h.view.state.statistics){
        assert.equal(statistic.visible,true);
        assert.equal(statistic.plotId,1);
        assert.deepEqual(statistic.rows.map(row=>[row.key,row.state]),[["1","waiting"],["2","value"]]);
    }
    const styles=h.view.state.statistics.map(statistic=>statistic.styleIndex);
    await h.finish();h.controller.setArea(box(10),"Next area");await h.tick();
    assert.equal(h.view.state.showingPrevious,true);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.previousRows.every(row=>row.state==="value")));
    await h.finish("ready",false,"2");
    assert.equal(h.view.state.showingPrevious,false);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.previousRows===null && statistic.rows[0].state==="waiting"));
    h.view.actions.onOrder("name","reverse");
    assert.deepEqual(h.view.state.statistics.map(statistic=>statistic.styleIndex),styles);
    assert.ok(h.view.state.statistics.every(statistic=>statistic.rows[0].key==="2"));
    h.controller.removeFormula(2);h.controller.addFormula("sum");
    assert.equal(h.view.state.statistics.find(statistic=>statistic.id===3).styleIndex,2);
    assert.equal(new Set(h.view.state.statistics.map(statistic=>statistic.styleIndex)).size,3);
    h.close();
});

test("later raster can plan and finish while the first raster's plan is still in flight",async()=>{
    const h=fixture(), gate=deferred(), plan=h.api.planCalculation;
    h.api.planCalculation=async intent=>{
        const result=await plan(intent);
        if(intent.source.itemId==="1")await gate.promise;
        return result;
    };
    await h.open();
    assert.equal(h.requests.filter(([kind])=>kind==="plan").length,2);
    await h.finish("ready",false,"2");
    assert.deepEqual(h.view.state.rows.map(row=>row.state),["waiting","value"]);
    assert.equal(h.area.busy,true);
    gate.resolve();await flush();await h.finish("ready",false,"1");
    assert.equal(h.area.complete,true);h.close();
});

test("unclassified planning rejection leaves an actionable gap and retries only failed rows",async()=>{
    const h=fixture(), plan=h.api.planCalculation;let full=true;
    h.api.planCalculation=async intent=>{
        if(full&&intent.source.itemId==="1")throw new ProcessingRequestError("Planning queue is full. Try again.",429);
        return plan(intent);
    };
    await h.open();await h.finish("ready",false,"2");
    assert.match(h.view.state.rows[0].errorMessage,/Planning queue is full/);
    assert.equal(h.area.hasErrors,true);assert.equal(h.area.busy,false);
    full=false;await h.area.calculateRemainingRasters();await flush();await h.finish("ready",false,"1");
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);h.close();
});

test("64 rasters dispatch without a browser worker limit and one cancel stops all",async()=>{
    const h=fixture();
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i+1))));
    h.area.updateCalculationInputs(Array.from({length:64},(_,i)=>source(String(i+1))),box(0),"Box",[{id:1,label:"Mean",expression:"mean(a)"}]);
    h.area.updateCalculationForPanelVisibility(true);await h.tick();
    assert.equal(h.server.size,64);assert.equal(h.storage.savedClientNames().length,64);
    assert.equal(h.jobs.listeners.size,64,"all executors share the same observer");
    h.area.cancelRemainingRasters();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,64);
    h.close();
});

test("all 64 rasters finish automatically through smaller plan and job queues",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const h=fixture(), heldPlans=new Set(), submit=h.api.submitCalculation, discard=h.api.discardPlan;
    const attempts=new Map();let planRejections=0,jobRejections=0;
    const transport=new ProcessingApiClient(async(url,options)=>{
        if(url.endsWith("/jobs")) return Response.json({jobs:[]});
        const planId=url.split("/").at(-1);
        assert.equal(options.method,"POST");
        if(heldPlans.size>=8 && !heldPlans.has(planId)) {
            planRejections++;
            return Response.json({detail:{code:"plan_queue_full",message:"Queue full"}},
                {status:429,headers:{"Retry-After":"5"}});
        }
        const input=JSON.parse(options.body);
        heldPlans.add(planId);
        h.plans.set(planId,{source:input.sources.a,calculations:input.calculations});
        return Response.json({planId,status:"ready",result:{planId,operation:"raster.aggregate.v1",
            grid:{...h.grid,dtype:"float32",transform:[1,0,0,0,-1,0]},expiresAt:"2099-01-01T00:00:00Z"}});
    },null);
    h.api.planCalculation=(...args)=>transport.planCalculation(...args);
    h.api.discardPlan=async id=>{heldPlans.delete(id);return discard(id);};
    h.api.submitCalculation=async request=>{
        const prior=attempts.get(request.planId);
        if(prior) assert.equal(request.requestId,prior,"capacity retries keep the same request key");
        attempts.set(request.planId,request.requestId);
        if([...h.server.values()].filter(job=>job.status==="running").length>=4) {
            jobRejections++;throw new ProcessingRequestError("Queue full",429,"owner_queue_full",5);
        }
        return submit(request);
    };
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i))));
    await h.open();
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.server.size,4);
    assert.ok([...h.area.progress.values()].some(value=>/retrying automatically/.test(value.message)));
    for(let round=0;round<20 && !h.area.complete;round++) {
        for(const job of [...h.server.values()].filter(job=>job.status==="running")) await h.finish("ready",false,job.sources.a.itemId);
        context.mock.timers.tick(31000);await flush();
    }
    assert.ok(planRejections>0 && jobRejections>0);
    assert.equal(h.area.complete,true);
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.area.results.size,64);
    assert.equal(h.view.state.rows.length,64);
    assert.equal(h.server.size,64,"each raster was accepted exactly once");
    assert.equal(heldPlans.size,0);
    assert.deepEqual(h.storage.savedClientNames(),[]);
    assert.equal(h.area.budget.nativeBlocks,64);
    h.close();
});

test("reload recovers and cancels all 64 independent submissions",async()=>{
    const h=fixture();
    h.controller.updateAvailableRasters(Array.from({length:64},(_,i)=>source(String(i))));
    await h.open();h.close();
    const recovered=fixture(h.api,h.data);
    await recovered.area.recoverAndCancelPreviousSeriesCalculations();await flush();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,64);
    assert.ok([...h.server.values()].every(job=>job.status==="cancelling"));
    recovered.close();
});

test("replacing an expired plan counts that raster only once toward confirmation",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;h.grid.nativeBlocks=64;
    let expired=false;
    h.api.submitCalculation=async request=>{
        if(!expired && h.plans.get(request.planId).source.itemId==="1") {
            expired=true;throw new ProcessingRequestError("Plan expired",409,"plan_unavailable");
        }
        return submit(request);
    };
    await h.open();
    assert.equal(h.area.confirmation,false);
    assert.equal(h.area.budget.nativeBlocks,128);
    await h.finish();await h.finish();assert.equal(h.area.complete,true);h.close();
});

test("reordering sources before confirming the rest cannot overwrite a running raster",async()=>{
    const h=fixture();h.grid.nativeBlocks=80;await h.open();
    assert.equal(h.area.confirmation,true);
    h.area.updateCalculationInputs([source("2"),source("1")],box(0),"Renamed",h.area.formulas);
    await h.area.calculateRemainingRasters();await flush();
    assert.equal(h.server.size,2);
    await h.finish("ready",false,"2");await h.finish("ready",false,"1");
    assert.equal(h.area.results.get("1").job.sources.a.itemId,"1");
    assert.equal(h.area.results.get("2").job.sources.a.itemId,"2");h.close();
});

test("cancelling a series leaves concurrent summary and clip jobs running",async()=>{
    const h=fixture();
    const summary=h.calculationRequests.createClient("summary",state=>{if(state.isIdle&&state.plan)summary.submit(state.plan.planId);});
    summary.prepare({source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Mean",expression:"mean(a)"}]});
    const clip={jobId:"c".repeat(32),operation:"raster.clip.v1",status:"running",sources:{a:{itemId:"clip"}}};
    h.server.set(clip.jobId,clip);h.jobs.accept(clip);
    await h.open();h.area.cancelRemainingRasters();await flush();
    const cancelled=h.requests.filter(([kind])=>kind==="cancel").map(([,id])=>h.server.get(id).sources.a.itemId);
    assert.deepEqual(cancelled.sort(),["1","2"]);
    assert.equal([...h.server.values()].find(job=>job.sources.a.itemId==="summary").status,"running");
    assert.equal(h.server.get(clip.jobId).status,"running");h.close();
});

test("cancellation during uncertain concurrent submissions recovers all original keys",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{await submit(input);throw Error("Lost reply");};
    await h.open();assert.equal(h.area.needsRecovery,true);
    const originals=h.requests.filter(([kind])=>kind==="submit").map(([,input])=>input);
    h.area.cancelRemainingRasters();h.api.submitCalculation=submit;
    await h.area.retryInterruptedCalculations();await flush();
    for(const input of originals)assert.equal(h.requests.filter(([kind,value])=>kind==="submit"&&value.requestId===input.requestId).length,2);
    assert.equal(h.server.size,2);assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");
    assert.equal(h.area.results.size,0);assert.deepEqual(h.storage.savedClientNames(),[]);h.close();
});

test("each raster's wait starts at dispatch, while whole-series time ends at the last result",async()=>{
    const h=fixture();await h.open();
    await h.finish("ready",false,"2");await h.finish("ready",false,"1");
    assert.equal(h.area.results.get("2").elapsedSeconds,0.1);
    assert.equal(h.area.results.get("1").elapsedSeconds,0.2);
    assert.equal(h.area.elapsedSeconds,0.2,"overlapping request durations are not added");
    for(const result of h.area.results.values()) {
        const report=result.performanceLines.join(" ");
        assert.match(report,/Planning round trip: 0.000 s/);
        assert.match(report,/Excludes earlier area selection, formula debounce and validation/);
        assert.doesNotMatch(report,/result displayed|including vector selection when requested here/);
    }
    h.close();
});

test("series report accounts for planning, submission and result observation using executor timestamps",async()=>{
    const h=fixture();h.controller.updateAvailableRasters([source("1")]);
    const plan=h.api.planCalculation,submit=h.api.submitCalculation,validate=h.api.validateCalculation;
    h.api.validateCalculation=async formulas=>{h.elapse(700);return validate(formulas);};
    h.api.planCalculation=async intent=>{
        h.elapse(1200);
        return {...await plan(intent),timing:{reservationSeconds:.1,preparationSeconds:.2,nativeProcessSeconds:.3,finalizationSeconds:.1,queueSeconds:.2},
            planningObservation:{sseHints:3,sseRefreshes:2,timerRefreshes:1,readyResponse:"timer"}};
    };
    h.api.submitCalculation=async input=>{h.elapse(300);return submit(input);};
    await h.open();h.elapse(3900);await h.finish();
    const result=h.area.results.get("1"),report=result.performanceLines.join(" ");
    assert.equal(result.elapsedSeconds,5.5,"earlier validation is excluded");
    assert.match(report,/Before planning: 0.000 s/);
    assert.match(report,/Planning round trip: 1.200 s/);
    assert.match(report,/Between planning and submission: 0.000 s/);
    assert.match(report,/Submission round trip: 0.300 s/);
    assert.match(report,/Submission response → result observed: 4.000 s/);
    assert.match(report,/Total measured wait: 5.500 s/);
    assert.match(report,/Inside server planning - admission: 0.100 s/);
    assert.match(report,/Waiting for the native planner: 0.200 s/);
    assert.match(report,/3 SSE hints received; 2 SSE-triggered status reads; 1 two-second fallback status reads/);
    assert.match(report,/Plan ready was first observed in a two-second fallback status read/);
    assert.match(report,/do not measure calculation-result delivery after submission/);
    assert.match(report,/do not add the two groups together/);
    h.close();
});

test("reload recovers multiple lost submissions with original keys before cancellation",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{await submit(input);throw Error("Lost reply");};
    await h.open();
    const originals=h.requests.filter(([kind])=>kind==="submit").map(([,input])=>input);
    const oldJobs=[...h.server];h.close();
    const restored=fixture({},h.data);
    for(const [id,job]of oldJobs)restored.server.set(id,job);
    await restored.area.recoverAndCancelPreviousSeriesCalculations();await flush();
    assert.deepEqual(restored.requests.filter(([kind])=>kind==="submit").map(([,input])=>input),originals);
    assert.equal(restored.server.size,2);
    assert.equal(restored.requests.filter(([kind])=>kind==="cancel").length,2);
    await restored.finish("cancelled");await restored.finish("cancelled");
    assert.deepEqual(restored.storage.savedClientNames(),[]);restored.close();
});

test("a full recovery store prevents submission of that raster without losing a peer record",async()=>{
    const h=fixture(), write=h.storage.storage.setItem;
    h.storage.storage.setItem=(key,value)=>{
        if(key.endsWith("raster-series:1"))throw Error("Storage full");
        write(key,value);
    };
    await h.open();
    assert.equal(h.server.size,1);
    assert.match(h.area.results.get("2").error,/Storage full/);
    assert.deepEqual(h.storage.savedClientNames(),["raster-series:0"]);
    await h.finish();h.close();
});

test("the shared activity indicator stays active until every submitted calculation settles",async()=>{
    const h=fixture(), activity=[];
    h.calculationRequests.dependencies.onActivity=area=>activity.push(area);
    await h.open();await h.finish();
    assert.deepEqual(activity.at(-1),box(0));
    await h.finish();assert.equal(activity.at(-1),null);h.close();
});
