import test from "node:test";
import assert from "node:assert/strict";
import { RasterSeriesCalculations } from "../../src/processing/raster-series-calculations.js";
import { RasterSeriesController } from "../../src/raster/series.js";
import { CalculationRequests } from "../../src/processing/calculation-requests.js";
import { CalculationSessionStorage } from "../../src/processing/calculation-session.js";
import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import { ProcessingJobs } from "../../src/processing/jobs.js";
import { ProcessingApiClient, ProcessingRequestError } from "../../src/processing/api.js";
import { ProcessingDiagnostics } from "../../src/processing/diagnostics.js";

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
    const clock={setTimeout(fn,delay){const id=++serial;timers.set(id,{fn,delay,at:time+delay});return id;},clearTimeout(id){timers.delete(id);}};
    const grid={nativeBlocks:1,decodedBytes:100,width:10,height:10,crs:"EPSG:4326"};
    const api={
        diagnostics:new ProcessingDiagnostics(()=>time),
        validateCalculation:async formulas=>{requests.push(["validate",formulas]);return {valid:true};},
        planCalculation:async intent=>{const planId=String(++serial).padStart(32,"0");requests.push(["plan",intent]);plans.set(planId,intent);return {planId,grid,expiresAt:"2099-01-01T00:00:00Z"};},
        discardPlan:async id=>{requests.push(["discard",id]);},
        submitCalculation:async submission=>{
            requests.push(["submit",submission]);
            const existing=[...server.values()].find(job=>job.requestId===submission.requestId); if(existing)return existing;
            const intent=submission.planId ? plans.get(submission.planId) : submission;
            const job={jobId:submission.planId ?? String(++serial).padStart(32,"0"),requestId:submission.requestId,operation:"raster.aggregate.v1",status:"running",progress:{phase:"calculating",completedBlocks:0,totalBlocks:1},grid,
                calculations:intent.calculations,sources:{a:intent.source},result:null};
            server.set(job.jobId,job);return job;
        },
        listJobs:async()=>[...server.values()],getJob:async id=>server.get(id),
        cancelJob:async id=>{requests.push(["cancel",id]);const job={...server.get(id),status:"cancelling"};server.set(id,job);return job;},
        /** @param {string[]} ids Requested IDs. @return {Promise<Object>} Owned statuses. */
        async readJobStatuses(ids) {
            const records = await this.listJobs();
            return {jobs: records.filter(job => ids.includes(job.jobId)),
                unavailableJobIds: ids.filter(id => !records.some(job => job.jobId === id))};
        },
        ...overrides,
    };
    const storage=new CalculationSessionStorage({get length(){return data.size;},key:index=>[...data.keys()][index]??null,
        getItem:key=>data.get(key),setItem:(key,value)=>data.set(key,value),removeItem:key=>data.delete(key)});
    const jobs=new ProcessingJobs(api,clock);
    const calculationRequests=new CalculationRequests({api,jobs,storage,now:()=>time,requestId:()=>"request-"+String(++serial).padStart(16,"0")});
    const area=new RasterSeriesCalculations({requests:calculationRequests,clock,now:()=>time});
    const view={bind(actions){this.actions=actions;},render(state){this.state=state;},downloadCsv(csv){this.csv=csv;}};
    const controller=new RasterSeriesController({view,areaStatistics:area,samplePoint:async()=>({inBounds:true,value:1}),onClose(){},onEditArea(){}});
    controller.updateAvailableRasters([source("1"),source("2")]); controller.setArea(box(0),"First box");
    const tick=async(delay=0)=>{for(const[id,t]of [...timers])if(t.delay===delay){timers.delete(id);t.fn();}await flush();};
    /** Advance the browser clock and execute only callbacks whose deadlines passed.
     * @param {number} milliseconds Elapsed time. @return {Promise<void>} Settled lifecycle callbacks.
     */
    const advance=async milliseconds=>{time+=milliseconds;for(const[id,t]of [...timers])if(t.at<=time){timers.delete(id);t.fn();}await flush();};
    const finish=async(status="ready",cacheHit=false,itemId=null)=>{
        const old=[...server.values()].find(job=>["running","cancelling","queued"].includes(job.status) && (!itemId || job.sources.a.itemId===itemId));
        assert.ok(old,"an active job exists");
        time+=100;
        server.set(old.jobId,{...old,status,result:status==="ready"?{cacheHit,rows:old.calculations.map((row,i)=>({...row,value:i?"22":"-123.4567890123456789",unit:row.expression.startsWith("areaha")?"ha":null,state:"ok",valueType:"float",aggregates:[]}))}:null,error:status==="failed"?{detail:"Raster unavailable"}:null});
        await jobs.refresh();await flush();return old.jobId;
    };
    const open=async()=>{controller.setMode("area");controller.updateSamplingForPanelVisibility(true);await tick();};
    const close=()=>{area.destroy();calculationRequests.destroy();jobs.destroy();};
    return {api,calculationRequests,jobs,storage,data,area,controller,view,requests,plans,server,grid,tick,advance,finish,open,close,elapse:ms=>{time+=ms;}};
}

test("formulas share one job per source, retain exact scalar/unit CSV, and presentation edits do not recalculate",async()=>{
    const h=fixture();h.controller.addFormula("area");await h.open();
    assert.equal(h.requests.filter(([k])=>k==="submit").length,2);
    assert.equal(h.requests.find(([k])=>k==="submit")[1].calculations.length,2);
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





test("rapid area changes cancel submitted work and never mix old-area rows",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");await h.tick();
    assert.ok(h.view.state.previousRows);assert.equal(h.view.state.rows.some(row=>row.state==="value"),false);
    h.controller.setArea(box(20),"Third");await h.tick();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,2);
    await h.finish("cancelled");await h.finish("cancelled");await flush();
    const planned=h.requests.filter(([kind])=>kind==="submit").at(-1)[1];
    assert.equal(planned.area.selectedBounds.west,20);
    await h.finish();await h.finish();
    assert.equal(h.area.results.size,2);
    for(const result of h.area.results.values())assert.equal(result.calculationInputs.area.selectedBounds.west,20);
    h.close();
});

test("committed areas submit on the next turn and coalesce synchronous replacements",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.setArea(box(10),"Second");
    h.controller.setArea(box(20),"Latest");
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2,"dispatch waits until the current event completes");
    await h.advance(0);
    const replacements=h.requests.filter(([kind])=>kind==="submit").slice(2);
    assert.equal(replacements.length,2);
    assert.ok(replacements.every(([,request])=>request.area.selectedBounds.west===20));
    await h.finish();await h.finish();
    assert.equal(h.area.elapsedSeconds,.2,"whole-series time has no additional 700 ms editing pause");
    await h.advance(700);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,4,"no stale delayed submission follows");
    h.close();
});

test("opening area statistics and changing selected rasters require no editing pause",async()=>{
    const h=fixture();h.controller.setMode("area");h.controller.updateSamplingForPanelVisibility(true);
    assert.equal(h.requests.length,0);
    await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    await h.finish();await h.finish();
    h.controller.selectRaster("2",false);await h.advance(0);
    const submissions=h.requests.filter(([kind])=>kind==="submit");
    assert.equal(submissions.length,3);
    assert.equal(submissions.at(-1)[1].source.itemId,"1");
    h.close();
});

test("reopening unfinished area statistics schedules remaining work immediately",async()=>{
    const h=fixture();await h.open();
    h.controller.updateSamplingForPanelVisibility(false);await flush();
    await h.finish("cancelled");await h.finish("cancelled");
    h.controller.updateSamplingForPanelVisibility(true);await h.advance(0);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,4);
    assert.equal(h.area.pending.size,2);
    h.close();
});

test("formula typing waits 700 ms after the latest expression and submits only that expression",async()=>{
    const h=fixture();await h.open();await h.finish();await h.finish();
    h.controller.editFormula(1,{expression:"mean(a)+1"});
    await h.advance(699);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    h.controller.editFormula(1,{expression:"mean(a)+2"});
    await h.advance(699);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2,"the later edit restarts the pause");
    await h.advance(1);
    const replacements=h.requests.filter(([kind])=>kind==="submit").slice(2);
    assert.equal(replacements.length,2);
    assert.ok(replacements.every(([,request])=>request.calculations[0].expression==="mean(a)+2"));
    await h.finish();await h.finish();
    assert.equal(h.area.elapsedSeconds,.9,"formula editing still contributes its deliberate pause");
    h.close();
});

for(const action of ["hide","cancel"]) {
    test(`${action} before the next turn prevents a committed-area submission`,async()=>{
        const h=fixture();await h.open();await h.finish();await h.finish();
        h.controller.setArea(box(10),"Pending");
        if(action==="hide")h.controller.updateSamplingForPanelVisibility(false);
        else h.area.cancelRemainingRasters();
        await h.advance(0);await h.advance(1000);
        assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
        assert.equal(h.area.pending.size,0);
        h.close();
    });
}

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
    summary.submit({source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Mean",expression:"mean(a)"}]});
    await flush();
    assert.equal(h.server.size,3,"all three submissions precede any result");
    await h.finish("ready",false,"summary");
    assert.ok(snapshots.every(state=>!state.completedJob||state.completedJob.sources.a.itemId==="summary"));
    assert.equal(h.area.results.size,0);
    await h.finish("ready",false,"2");
    assert.deepEqual(h.view.state.rows.map(row=>row.state),["waiting","value"]);
    await h.finish();assert.equal(h.area.complete,true);h.close();
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
    const recoveredResult=[...h.area.results.values()].find(result=>result.job.requestId===saved.pending.requestId);
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

        await h.area.calculateRemainingRasters();await flush();await h.finish();await h.finish();
        for(const [,intent]of h.requests.filter(([kind])=>kind==="submit"))assert.deepEqual(intent.area,area);
        assert.equal(h.area.complete,true);h.close();
    }
});

test("inline cached completions retain all source positions without queuing extra jobs",async()=>{
    const h=fixture(),submit=h.api.submitCalculation;
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

test("submission rejects invalid formulas with one shared explanation and retains the five-formula limit",async()=>{
    const h=fixture({submitCalculation:async()=>{throw new ProcessingRequestError("Unknown function bad",422);}});
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
    await h.tick(700);
    assert.match(h.view.state.message,/Unknown function bad/);
    assert.equal(h.requests.filter(([kind])=>kind==="validate").length,0);
    assert.equal(h.area.results.size,2);
    assert.ok(h.view.state.rows.every(row=>row.errorMessage==="Not calculated. See the message above."));
    assert.deepEqual(h.storage.savedClientNames(),[],"known rejection needs no recovery");h.close();
});

test("all 25 rasters submit without a formula preflight and an edited rejection can succeed",async()=>{
    const h=fixture({validateCalculation:()=>{throw Error("Unexpected validation preflight");}});
    h.controller.updateAvailableRasters(Array.from({length:25},(_,i)=>source(String(i))));
    const submit=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{
        if(value.calculations[0].expression==="bad(a)") throw new ProcessingRequestError("Unknown function bad",422);
        return submit(value);
    };
    h.controller.editFormula(1,{expression:"bad(a)"});await h.open();
    assert.equal(h.area.results.size,25);assert.match(h.area.commonError,/Unknown function bad/);
    h.controller.editFormula(1,{expression:"mean(a)"});await h.tick(700);
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,25);
    assert.equal(h.area.commonError,"");assert.equal(h.area.pending.size,25);
    for(let i=0;i<25;i++) await h.finish();
    assert.equal(h.area.complete,true);assert.equal(h.area.hasErrors,false);h.close();
});

test("mixed raster failures retain their own explanations instead of a shared formula error",async()=>{
    const h=fixture();const submit=h.api.submitCalculation;
    h.api.submitCalculation=async value=>{
        if(value.source.itemId==="2") throw new ProcessingRequestError("Source is unavailable",404);
        return submit(value);
    };
    await h.open();await h.finish();
    assert.equal(h.area.commonError,"");assert.match(h.area.message,/Some rasters failed/);
    assert.match(h.view.state.rows.find(row=>row.key==="2").errorMessage,/Source is unavailable/);h.close();
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
    summary.submit(intent);summary.submit({...intent,area:box(10)});summary.stop();
    assert.equal(h.requests.filter(([kind])=>kind==="cancel").length,0);
    await h.finish();await h.finish();
    assert.equal([...h.server.values()].find(job=>job.sources.a.itemId==="summary").status,"cancelling");
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

test("later raster can finish while the first raster's submission response is still in flight",async()=>{
    const h=fixture(), gate=deferred(), submit=h.api.submitCalculation;
    h.api.submitCalculation=async intent=>{
        const result=await submit(intent);
        if(intent.source.itemId==="1")await gate.promise;
        return result;
    };
    await h.open();
    assert.equal(h.requests.filter(([kind])=>kind==="submit").length,2);
    await h.finish("ready",false,"2");
    assert.deepEqual(h.view.state.rows.map(row=>row.state),["waiting","value"]);
    assert.equal(h.area.busy,true);
    gate.resolve();await flush();await h.finish("ready",false,"1");
    assert.equal(h.area.complete,true);h.close();
});

test("unclassified submission rejection leaves an actionable gap and retries only failed rows",async()=>{
    const h=fixture(), submit=h.api.submitCalculation;let full=true;
    h.api.submitCalculation=async intent=>{
        if(full&&intent.source.itemId==="1")throw new ProcessingRequestError("Submission rejected. Try again.",429);
        return submit(intent);
    };
    await h.open();await h.finish("ready",false,"2");
    assert.match(h.view.state.rows[0].errorMessage,/Submission rejected/);
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

test("all 64 rasters finish automatically through a smaller job queue",async context=>{
    context.mock.timers.enable({apis:["setTimeout"]});
    const h=fixture(), submit=h.api.submitCalculation;
    const attempts=new Map();let jobRejections=0;
    h.api.submitCalculation=async request=>{
        const prior=attempts.get(request.source.itemId);
        if(prior) assert.equal(request.requestId,prior,"capacity retries keep the same request key");
        attempts.set(request.source.itemId,request.requestId);
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
    assert.ok(jobRejections>0);
    assert.equal(h.area.complete,true);
    assert.equal(h.area.hasErrors,false);
    assert.equal(h.area.results.size,64);
    assert.equal(h.view.state.rows.length,64);
    assert.equal(h.server.size,64,"each raster was accepted exactly once");
    assert.equal(h.requests.filter(([kind])=>kind==="plan").length,0);
    assert.deepEqual(h.storage.savedClientNames(),[]);
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





test("cancelling a series leaves concurrent summary and clip jobs running",async()=>{
    const h=fixture();
    const summary=h.calculationRequests.createClient("summary",state=>{if(state.isIdle&&state.plan)summary.submit(state.plan.planId);});
    summary.submit({source:{collectionId:"catalog",itemId:"summary",label:"Summary"},area:box(0),calculations:[{label:"Mean",expression:"mean(a)"}]});
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
        assert.match(report,/Submission round trip: 0.000 s/);
        assert.match(report,/Excludes earlier area selection, formula debounce, and subsequent UI rendering/);
        assert.doesNotMatch(report,/result displayed|including vector selection when requested here/);
    }
    h.close();
});

test("series report accounts for submission, queued preparation and result observation",async()=>{
    const h=fixture();h.controller.updateAvailableRasters([source("1")]);
    const submit=h.api.submitCalculation;
    h.api.submitCalculation=async input=>{h.elapse(300);return submit(input);};
    await h.open();
    const job=[...h.server.values()][0];
    h.server.set(job.jobId,{...job,preparation:{seconds:.2,cacheHit:false,process:null}});
    h.elapse(3500);await h.finish();
    const result=h.area.results.get("1"),report=result.performanceLines.join(" ");
    assert.equal(result.elapsedSeconds,3.9,"validation is part of submission");
    assert.match(report,/Before submission: 0.000 s/);
    assert.doesNotMatch(report,/Planning round trip/);
    assert.match(report,/Submission round trip: 0.300 s/);
    assert.match(report,/Submission response → result observed: 3.600 s/);
    assert.match(report,/Total measured wait: 3.900 s/);
    assert.match(report,/Calculation preparation: 0.200 s/);
    assert.match(report,/Ready job first received at \+3.900 s from explicit refresh/);
    assert.match(report,/Executor ready → result consumer: 0.000 s/);
    assert.ok(report.includes(`job ${result.job.jobId}`));
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
