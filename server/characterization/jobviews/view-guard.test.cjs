const test=require('node:test'),assert=require('node:assert/strict'),{guard}=require('./view-guard.cjs');
const product='client-report/src/components/topicPage/TopicPage.jsx';
for(const file of ['client-report/src/data/__tests__/jobViews.golden.json','client-report/src/data/__tests__/jobViews.recordings.test.jsx','client-report/src/data/__tests__/baseline-view-source.json','client-report/jest.jobviews.config.cjs','.github/workflows/job-views.yml','server/characterization/jobviews/view-guard.cjs'])test(`refuse product plus ${file}`,()=>assert.throws(()=>guard([product,file])));
test('product plus new focused tests allowed',()=>guard([product,'client-report/src/data/__tests__/jobViews.enabled.test.jsx']));
test('baseline-only allowed',()=>guard(['client-report/src/data/__tests__/jobViews.golden.json']));
for(const file of ['server/characterization/delphi/recordings/completed/delphi.json','client-report/src/data/provenance.js','client-participation-alpha/src/lib/provenance.ts','server/characterization/jobviews/expected.cjs'])test(`source rules ${file}`,()=>assert.throws(()=>guard([product,file])));
test('pending differences refused',()=>assert.throws(()=>guard([product],{entries:[{ruling:'pending'}]})));
test('free-form ruling refused',()=>assert.throws(()=>guard([product],{entries:[{ruling:'approved'}]})));
test('golden absorbs differences',()=>assert.throws(()=>guard(['client-report/src/data/__tests__/jobViews.golden.json'],{entries:[{ruling:'ruled:generated'}]})));
