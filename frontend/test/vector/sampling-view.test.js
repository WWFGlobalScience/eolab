import test from "node:test";
import assert from "node:assert/strict";
import { VectorSamplingView } from "../../src/vector/sampling-view.js";
import { VectorSamplingController } from "../../src/vector/sampling.js";
import { FakeRasterControlDocument } from "../../test-support/raster/fake-controls-document.js";

test("Explore and summary vector controls share selection, review, filter actions, and removal", async()=>{
    const document=new FakeRasterControlDocument();
    const explore=new VectorSamplingView(document);
    const summary=new VectorSamplingView(document,{root:"#calculations-vector-area",choice:null,disclosure:null});
    const filter={enabled:true,match:"all",rules:[{field:"iso3",operator:"eq",value:"PER"}]};
    const targets=[{key:"countries",label:"Countries",item:{collection:"vectors",id:"countries"},filter}];
    const area={id:"A".repeat(32),filter,bbox:[-180,-85,180,85],matched:1,total:253,
        expiresAt:"2099-01-01T00:00:00Z"};
    const events=[];
    const controller=new VectorSamplingController({view:[explore,summary],getTargets:()=>targets,
        createArea:async()=>area,removeArea:async id=>events.push(["remove",id]),
        onActivate:area=>events.push(["activate",area.id]),onInvalidate:id=>events.push(["invalidate",id]),
        onEditFilter:key=>events.push(["filter",key]),clock:{setTimeout(){},clearTimeout(){}}});
    assert.equal(summary.elements.layer.value,"countries");
    assert.equal(summary.elements.predicate.textContent,'iso3 equals "PER"');
    summary.elements.filter.dispatchEvent(new Event("click"));
    assert.deepEqual(events,[["filter","countries"]]);
    summary.elements.use.dispatchEvent(new Event("click"));
    assert.equal(summary.elements.use.disabled, true);
    assert.match(summary.elements.use.textContent, /Reading selected features/);
    assert.equal(summary.elements.status.classList.contains("is-working"), true);
    for(let i=0;i<10;i++) await Promise.resolve();
    assert.equal(summary.elements.confirm.hidden,false);
    assert.equal(summary.elements.status.getAttribute("role"), "alert");
    assert.equal(summary.elements.status.classList.contains("vector-selection-warning"), true);
    assert.equal(summary.elements.status.classList.contains("is-working"), false);
    assert.equal(explore.elements.status.textContent,summary.elements.status.textContent);
    summary.elements.confirm.dispatchEvent(new Event("click"));
    assert.match(explore.elements.confirm.textContent,/near-global/);
    explore.elements.confirm.dispatchEvent(new Event("click"));
    assert.deepEqual(events.at(-1),["activate",area.id]);
    assert.equal(summary.elements.status.getAttribute("role"), "status");
    assert.equal(summary.elements.status.classList.contains("vector-selection-warning"), false);
    summary.elements.remove.dispatchEvent(new Event("click"));
    assert.equal(explore.elements.remove.hidden,true);
    assert.equal(summary.elements.remove.hidden,true);
    controller.destroy();
    summary.elements.filter.dispatchEvent(new Event("click"));
    assert.equal(events.filter(event=>event[0]==="filter").length,1);
});

test("summary vector controls explain missing polygon layers without offering an invalid selection",()=>{
    const document=new FakeRasterControlDocument();
    const view=new VectorSamplingView(document,{root:"#calculations-vector-area",choice:null,disclosure:null});
    const controller=new VectorSamplingController({view,getTargets:()=>[]});
    assert.match(view.elements.status.textContent,/Add a Shapefile or GeoPackage polygon layer/);
    assert.equal(view.elements.use.disabled,true);
    assert.equal(view.elements.filter.disabled,true);
    controller.destroy();
});
