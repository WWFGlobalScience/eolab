import { CATALOG_SELECTION } from "../../test-support/raster/fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { VectorSamplingController, createVectorSamplingArea } from "../../src/vector/sampling.js";

const filter = { enabled: true, match: "all", rules: [{field:"iso3",operator:"eq",value:"PER"}] };
const ready = { selection:CATALOG_SELECTION, filter, label:"Countries", matched:1, total:200 };
const otherFilter = { ...filter, rules: [{field:"iso3",operator:"eq",value:"CAN"}] };
/** Settle selection promise continuations. @return {Promise<void>} Settled continuations. */
const flush = async () => { for (let i=0;i<12;i++) await Promise.resolve(); };

/** Exercise accepted source changes through normal selection callbacks.
 * @param {(source:Object|null,filter:Object,signal:AbortSignal,target:Object)=>Promise<Object>} [createArea] Exact polygon preparation dependency.
 * @return {Object} Controller, visible state, events, releases and target replacement.
 */
function fixture(createArea = async (_source, candidate) => ({...ready, filter:candidate,
    selection:{...CATALOG_SELECTION,filter:candidate}})) {
    const events=[], released=[];
    let targets=[{key:"countries",label:"Countries",
        item:{collectionId:CATALOG_SELECTION.collectionId,itemId:CATALOG_SELECTION.itemId},filter}];
    const view={bind(h){this.handlers=h;},render(s){this.state=s;},unbind(){}};
    const controller=new VectorSamplingController({view,getTargets:()=>targets,createArea,
        onActivate:area=>events.push(["activate",area.selection ?? area.polygonArea]),
        onInvalidate:selection=>events.push(["invalidate",selection]),
        releaseArea:area=>released.push(area),onEditFilter:key=>events.push(["filter",key])});
    return {controller,view,events,released,change(next){targets=next;controller.refresh();}};
}

test("population does not read; explicit layer choice adopts and follows accepted source changes",async()=>{
    const reads=[];
    const h=fixture(async (_source,candidate)=>{
        reads.push(candidate);return {...ready,filter:candidate,selection:{...CATALOG_SELECTION,filter:candidate}};
    });
    h.change([{...h.view.state.targets[0],label:"Renamed countries"}]);await flush();
    assert.equal(reads.length,0);
    h.view.handlers.onLayer("countries");await flush();
    assert.equal(h.view.state.phase,"active");assert.equal(reads.length,1);
    assert.match(h.view.state.filterSummary,/iso3 equals "PER"/);
    h.change([{...h.view.state.targets[0],filter:otherFilter}]);await flush();
    assert.deepEqual(reads,[filter,otherFilter]);
    assert.deepEqual(h.events.map(event=>event[0]),["activate","invalidate","activate"]);
    assert.deepEqual(h.view.state.area.selection.filter,otherFilter);
    h.change([{...h.view.state.targets[0],label:"Another label"}]);await flush();
    assert.equal(reads.length,2,"presentation changes do not prepare another area");
});

test("two map views of one source follow only the chosen view's committed filter",async()=>{
    const reads=[],h=fixture(async (_source,candidate)=>{
        reads.push(candidate);return {...ready,filter:candidate,selection:{...CATALOG_SELECTION,filter:candidate}};
    });
    const first=h.view.state.targets[0],second={...first,key:"second-view",filter:otherFilter};
    h.change([first,second]);await h.controller.choose(second.key);
    assert.deepEqual(reads,[otherFilter]);
    h.change([{...first,filter:otherFilter},second]);await flush();
    assert.equal(reads.length,1);
    h.change([first,{...second,filter}]);await flush();
    assert.deepEqual(reads,[otherFilter,filter]);
    assert.equal(h.view.state.key,second.key);
});

test("unfiltered selections adopt directly and open the layer's filter",async()=>{
    const unfiltered={...filter,rules:[]};
    const area={...ready,matched:200,filter:unfiltered,
        selection:{...CATALOG_SELECTION,filter:unfiltered}};
    const h=fixture(async()=>area);h.change([{...h.view.state.targets[0],filter:unfiltered}]);
    await h.controller.use();
    assert.equal(h.view.state.phase,"active");
    assert.deepEqual(h.events,[["activate",area.selection]]);
    h.view.handlers.onFilter();assert.deepEqual(h.events.at(-1),["filter","countries"]);
});

test("a failed changed selection clears the old area and retries its current accepted filter",async()=>{
    let fail=false;
    const h=fixture(async (_source,candidate)=>{
        if(fail) throw Error("No matching polygon features");
        return {...ready,filter:candidate,selection:{...CATALOG_SELECTION,filter:candidate}};
    });
    await h.controller.use();fail=true;
    h.change([{...h.view.state.targets[0],filter:otherFilter}]);await flush();
    assert.equal(h.view.state.phase,"error");assert.equal(h.view.state.area,null);
    assert.match(h.view.state.message,/No matching polygon features/);
    assert.deepEqual(h.events.map(event=>event[0]),["activate","invalidate"]);
    fail=false;h.view.handlers.onRetry();await flush();
    assert.deepEqual(h.view.state.area.selection.filter,otherFilter);
    assert.equal(h.view.state.phase,"active");
});

test("filter changes abort and serialize preparation, releasing obsolete owned polygons",async()=>{
    const reads=[],h=fixture((_source,candidate,signal)=>new Promise(resolve=>reads.push({candidate,signal,resolve})));
    const first=h.controller.use();await flush();
    h.change([{...h.view.state.targets[0],filter:otherFilter}]);await flush();
    assert.equal(reads.length,1);assert.equal(reads[0].signal.aborted,true);
    const obsolete={...ready,selection:undefined,polygonArea:{id:"obsolete"}};
    reads[0].resolve(obsolete);await flush();
    assert.equal(await first,null);assert.equal(reads.length,2);
    assert.deepEqual(h.released,[obsolete]);assert.deepEqual(h.events,[]);
    const current={...ready,selection:{...CATALOG_SELECTION,filter:otherFilter},filter:otherFilter};
    reads[1].resolve(current);await flush();
    assert.deepEqual(h.events,[["activate",current.selection]]);
    assert.deepEqual(reads[1].candidate,otherFilter);
});

test("leaving vector sampling cancels preparation and stops following source changes",async()=>{
    let resolve;const h=fixture(()=>new Promise(done=>{resolve=done;}));
    const pending=h.controller.use();await flush();
    h.controller.invalidate("");
    h.change([{...h.view.state.targets[0],filter:otherFilter}]);
    const owned={...ready,selection:undefined,polygonArea:{id:"cancelled"}};resolve(owned);
    assert.equal(await pending,null);assert.deepEqual(h.events,[]);
    assert.deepEqual(h.released,[owned]);assert.equal(h.view.state.phase,"idle");
});

test("removing an active or preparing source never adopts another available layer",async()=>{
    const h=fixture();await h.controller.use();
    const replacement={...h.view.state.targets[0],key:"other-view"};
    h.change([replacement]);await flush();
    assert.equal(h.view.state.key,"");assert.equal(h.view.state.area,null);
    assert.deepEqual(h.events.map(event=>event[0]),["activate","invalidate"]);
    let resolve;const pending=fixture(()=>new Promise(done=>{resolve=done;}));
    const read=pending.controller.use();await flush();pending.change([replacement]);resolve(ready);await read;
    assert.deepEqual(pending.events,[]);assert.equal(pending.view.state.key,"");
});

test("clearing accepted owned polygons releases them and leaves an empty source choice",async()=>{
    const area={...ready,selection:undefined,polygonArea:{id:"owned-polygons"}};
    const h=fixture(async()=>area);await h.controller.use();
    h.view.handlers.onRemove();await flush();
    assert.equal(h.view.state.area,null);assert.equal(h.view.state.key,"");
    assert.deepEqual(h.released,[area]);
    assert.deepEqual(h.events.map(event=>event[0]),["activate","invalidate"]);
});

test("catalog and uploaded count-only responses activate the accepted source and filter",async t=>{
    for(const source of [{collectionId:CATALOG_SELECTION.collectionId,itemId:CATALOG_SELECTION.itemId},
        {uploadId:"75bdc2b7-dcc1-420a-b9b1-ed9db35e789d"}]) {
        const selection=source.uploadId?{...source,layerName:"areas",filter}:{...CATALOG_SELECTION,filter};
        let request;
        t.mock.method(globalThis,"fetch",async(url,options)=>{
            request={url,options};return new Response(JSON.stringify({...ready,label:source.uploadId ?? source.itemId,selection}));
        });
        const h=fixture(createVectorSamplingArea);
        h.change([{key:"polygons",label:"Reference sites",item:{...source,fields:[{name:"iso3",type:"str"}]},filter}]);
        const area = await h.controller.use();
        assert.equal(area.label, "Reference sites", "the chosen view supplies the display name instead of the API identifier");
        assert.deepEqual(JSON.parse(request.options.body),{...source,filter});
        assert.equal(request.url,"/api/vector-sampling/areas");
        assert.equal(request.options.headers["X-EOLab-Uploads"],source.uploadId?"1":undefined);
        assert.equal(request.options.credentials,"same-origin");assert.equal(request.options.cache,"no-store");
        assert.deepEqual(h.events,[["activate",selection]]);
    }
});


test("selection progress identifies user choices and passive refreshes with the existing read sequence", async () => {
    const states = [], h = fixture();
    h.controller.onSelectionState = state => states.push(state);
    await h.controller.choose("countries");
    const explicit = states.find(state => state.phase === "reading");
    assert.equal(explicit.explicit, true);
    h.change([{...h.view.state.targets[0], filter: otherFilter}]); await flush();
    const passive = states.filter(state => state.phase === "reading").at(-1);
    assert.equal(passive.explicit, false);
    assert.ok(passive.sequence > explicit.sequence);
    h.controller.refresh();
    assert.equal(states.at(-1).sequence, passive.sequence, "presentation refresh does not create another read identity");
    h.view.handlers.onRetry(); await flush();
    assert.equal(states.filter(state => state.phase === "reading").at(-1).explicit, true);
    await h.controller.choose("");
    assert.equal(states.at(-1).phase, "idle", "an empty choice does not invent a reading state");
    assert.equal(states.at(-1).explicit, true, "clearing is an explicit user intent");
    h.controller.destroy();
    assert.equal(states.at(-1).explicit, false, "ordinary invalidation cannot inherit a previous explicit choice");
});
