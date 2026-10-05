/* eslint-env node */
import React from 'react';
import fs from 'fs';
import path from 'path';
import {render,act,cleanup,renderHook,fireEvent} from '@testing-library/react';
import CommentsReport from '../../components/commentsReport/CommentsReport.jsx';
import TopicPage from '../../components/topicPage/TopicPage.jsx';
import TopicStats from '../../components/topicStats/TopicStats.jsx';
import TopicsVizReport from '../../components/topicsVizReport/TopicsVizReport.jsx';
import TopicDataProvider from '../../components/topicReport/TopicDataProvider.jsx';
import TopicSectionsBuilder from '../../components/topicReport/TopicSectionsBuilder.jsx';
import TopicAgenda from '../../../../client-participation-alpha/src/components/topicAgenda/TopicAgenda';
import * as agendaApi from '../../../../client-participation-alpha/src/api/topicAgenda';
import {fetchComments} from '../../../../client-participation-alpha/src/api/comments';
import {fetchParticipationInit} from '../../../../client-participation-alpha/src/api/participation';
import {fetchDelphiReport} from '../../../../client-participation-alpha/src/api/delphi';
import {useTopicData} from '../../../../client-participation-alpha/src/components/topicAgenda/hooks/useTopicData';
import net from '../../util/net';
import {fetchDelphiTopicData,fetchTopicModProximity} from '../../../../client-participation-alpha/src/api/delphi';

jest.mock('../../util/net',()=>({__esModule:true,default:{polisGet:jest.fn(),polisPost:jest.fn()}}));
jest.mock('../../components/framework/useReportId',()=>({useReportId:()=>({report_id:'generated-report'})}));
jest.mock('../../components/lists/commentList.jsx',()=>()=> <div data-view="comments"/>);
jest.mock('../../components/framework/heading.jsx',()=>()=> <div data-view="heading"/>);
jest.mock('../../components/framework/Footer.jsx',()=>()=> <div data-view="footer"/>);
jest.mock('../../components/topicStats/visualizations/TopicBeeswarm.jsx',()=>()=> <div data-view="beeswarm"/>);
jest.mock('../../components/topicStats/visualizations/AllCommentsScatterplot.jsx',()=>()=> <div data-view="scatter"/>);
jest.mock('jwt-decode',()=>({jwtDecode:()=>({})}));
jest.mock('../../../../client-participation-alpha/src/api/delphi',()=>({fetchDelphiTopicData:jest.fn(),fetchTopicModProximity:jest.fn(),fetchDelphiReport:jest.fn()}));
jest.mock('../../../../client-participation-alpha/src/api/topicAgenda',()=>({fetchTopicPrioritize:jest.fn(),fetchTopicAgendaSelections:jest.fn(),saveTopicAgendaSelections:jest.fn()}));
jest.mock('../../../../client-participation-alpha/src/api/comments',()=>({fetchComments:jest.fn()}));
jest.mock('../../../../client-participation-alpha/src/api/participation',()=>({fetchParticipationInit:jest.fn()}));
jest.mock('../../../../client-participation-alpha/src/lib/auth',()=>({getConversationToken:()=>null}));
jest.mock('../../../../client-participation-alpha/src/components/topicAgenda/components/LayerHeader',()=>()=> <div data-view="layer-header"/>);
jest.mock('../../../../client-participation-alpha/src/components/topicAgenda/components/TopicAgendaStyles',()=>()=>null);
jest.mock('../../../../client-participation-alpha/src/components/topicAgenda/components/ScrollableTopicsGrid',()=>props=> <div data-view="topic-grid" data-picks={[...props.selections].join(',')} data-runs={Object.keys(props.topicData?.runs||{}).join(',')}/>);
jest.mock('../../components/topicStats/CollectiveStatementModal.jsx',()=>()=>null);
jest.mock('../../components/topicStats/BeeswarmModal.jsx',()=>()=>null);
jest.mock('../../components/topicStats/AllCommentsModal.jsx',()=>()=>null);
jest.mock('../../components/topicStats/LayerDistributionModal.jsx',()=>()=>null);
jest.mock('../../components/topicStats/visualizations/TopicOverviewScatterplot.jsx',()=>p=> <pre data-view="overview">{JSON.stringify(p.latestRun)}</pre>);
jest.mock('../../components/topicStats/visualizations/TopicTables.jsx',()=>p=> <pre data-view="tables">{JSON.stringify(p.latestRun)}</pre>);
const dir=path.resolve(__dirname,'../../../../server/characterization/delphi/recordings');
const goldenPath=path.join(__dirname,'jobViews.golden.json');
const record=process.env.RECORD_JOB_VIEWS==='baseline';
const observe=process.env.JOB_VIEWS_OBSERVE;
const {expectedViews}=require('../../../../server/characterization/jobviews/expected.cjs');
if (record) {
 const pins=JSON.parse(fs.readFileSync(path.join(__dirname,'baseline-view-source.json')));
 for(const [file,sha] of Object.entries(pins)) {
  const actual=require('crypto').createHash('sha256').update(fs.readFileSync(path.resolve(__dirname,'../../../..',file))).digest('hex');
  if(actual!==sha) throw Error(`cannot record changed view: ${file}`);
 }
}
const golden=record?{}:JSON.parse(fs.readFileSync(goldenPath));
const differences=JSON.parse(fs.readFileSync(process.env.JOB_VIEWS_DIFFERENCES||path.join(__dirname,'jobViews.expected-differences.json')));
const expected=record||observe?{}:expectedViews(golden,differences);
const observed={};
const states=['not_run','pending','running','failed','completed','two_models','rerun_after_votes','truncated_narrative','zero_vote','mixed_jobs','partial_job','existing_statements'];
const {fixture}=require('../../../../server/characterization/jobviews/view-fixtures.cjs');
function body(state,file){return fixture(dir,state,file);}
const props={math:{},comments:[],conversation:{},ptptCount:0,formatTid:String,voteColors:{},reportModLevel:0};
const settle=async()=>{await act(async()=>{for(let i=0;i<15;i++)await Promise.resolve();});};
beforeEach(()=>{expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe('UTC');jest.clearAllMocks();jest.spyOn(console,'log').mockImplementation(()=>{});jest.spyOn(console,'warn').mockImplementation(()=>{});jest.spyOn(console,'error').mockImplementation(()=>{});});
afterEach(()=>{cleanup();jest.restoreAllMocks();});
for(const state of states) test(`recorded views ${state}`,async()=>{
 const topics=body(state,'delphi'),viz=body(state,'delphi-visualizations');const calls=[];
 const tids=Array.from({length:8},(_,i)=>i);
 const viewProps={...props,comments:tids.map(tid=>({tid,txt:`Generated statement ${tid}`})),math:state==='zero_vote'?{}:{'group-consensus-normalized':Object.fromEntries(tids.map(tid=>[tid,1])),'group-votes':{0:{'n-members':10,votes:Object.fromEntries(tids.map(tid=>[tid,{A:8,D:1,S:1}]))}}}};
 net.polisPost.mockImplementation(async(route,args,token)=>{calls.push(['POST',route,args,token]);if(route!=='/api/v3/collectiveStatement')throw Error(`unexpected POST ${route}`);return {status:'success',statementData:{paragraphs:[{sentences:[{clauses:[{text:'Generated paid response',citations:[]}]}]}]},created_at:'2023-11-14T21:00:00.000Z',model:'generated-model'};});
 net.polisGet.mockImplementation((route,args)=>{
  calls.push([route,args]);
  if(route==='/api/v3/delphi')return Promise.resolve(topics);
  if(route==='/api/v3/delphi/visualizations')return Promise.resolve(viz);
  if(route==='/api/v3/topicStats')return Promise.resolve(body(state,'topicStats'));
  if(route==='/api/v3/delphi/reports')return Promise.resolve(body(state,'delphi-reports'));
  if(route==='/api/v3/collectiveStatement')return Promise.resolve(body(state,'collectiveStatement'));
  if(route==='/api/v3/delphi/logs')return Promise.resolve([]);
  throw Error(`unexpected route ${route}`);
 });
 const c=render(<CommentsReport {...viewProps}/>);await settle();
 const comments={html:c.container.innerHTML,calls:[...calls]};
 const globalButton=c.queryByText('Global Insights');if(globalButton){fireEvent.click(globalButton);await settle();comments.globalHtml=c.container.innerHTML;comments.globalCalls=[...calls];}
 cleanup();calls.length=0;
 const key=Object.values(topics.runs).flatMap(r=>Object.values(r.topics_by_layer||{}).flatMap(Object.values))[0]?.topic_key||'missing#0#0';
 const t=render(<TopicPage {...viewProps} report_id="generated-report" token="generated-view-token" topic_key={key}/>);await settle();
 const topicPage={html:t.container.innerHTML,calls:[...calls]};cleanup();calls.length=0;
 const otherKey=Object.values(topics.runs).flatMap(r=>Object.values(r.topics_by_layer||{}).flatMap(Object.values)).at(-1)?.topic_key||'missing#0#0';
 const other=render(<TopicPage {...viewProps} report_id="generated-report" token="generated-view-token" topic_key={state==='existing_statements'?body(state,'collectiveStatement').statements[0].topic_key:otherKey}/>);await settle();
 const otherTopicPage={html:other.container.innerHTML,calls:[...calls]};cleanup();calls.length=0;
 fetchDelphiTopicData.mockResolvedValue(topics);fetchTopicModProximity.mockResolvedValue({status:'success',proximity_data:[]});
 const hook=renderHook(()=>useTopicData('generated-report',true));await settle();
 const alpha={hierarchy:hook.result.current.hierarchyAnalysis,topicData:hook.result.current.topicData,error:hook.result.current.error,topicCalls:fetchDelphiTopicData.mock.calls,proximityCalls:fetchTopicModProximity.mock.calls};
 cleanup();
 const agendaCalls=[];
 agendaApi.fetchTopicPrioritize.mockImplementation(async(...args)=>{agendaCalls.push(['prioritize',args]);return body(state,'topicPrioritize');});
 agendaApi.fetchTopicAgendaSelections.mockImplementation(async(...args)=>{agendaCalls.push(['restore',args]);return {status:'success',data:{archetypal_selections:[{topic_key:'earlier#0#0'}]}};});
 fetchDelphiReport.mockImplementation(async(...args)=>{agendaCalls.push(['report',args]);return topics;});
 fetchComments.mockImplementation(async(...args)=>{agendaCalls.push(['comments',args]);return [{tid:0,txt:'Generated statement'}];});
 fetchParticipationInit.mockImplementation(async(...args)=>{agendaCalls.push(['participation',args]);return {};});
 const agenda=render(<TopicAgenda conversation_id="generated-conversation" s={{selectTopics:'Select topics',doneWithCount:'Done ({{count}})',error:'Error'}}/>);await settle();
 const initial=agenda.container.innerHTML;const button=agenda.queryByText('Select topics');
 if(button){fireEvent.click(button);await settle();}
 const alphaAgenda={initial,opened:agenda.container.innerHTML,calls:agendaCalls};
 cleanup();calls.length=0;
 const statsView=render(<TopicStats {...viewProps} report_id="generated-report"/>);await settle();
 const topicStats={html:statsView.container.innerHTML,calls:[...calls]};cleanup();calls.length=0;
 const vizView=render(<TopicsVizReport report_id="generated-report"/>);await settle();
 const topicsViz={html:vizView.container.innerHTML,calls:[...calls]};cleanup();calls.length=0;
 const sectionsView=render(<TopicDataProvider report_id="generated-report">{data=><TopicSectionsBuilder {...data}>{value=><pre>{JSON.stringify(value)}</pre>}</TopicSectionsBuilder>}</TopicDataProvider>);await settle();
 const sections={html:sectionsView.container.innerHTML,calls:[...calls]};
 const value=JSON.parse(JSON.stringify({comments,topicPage,otherTopicPage,alpha,alphaAgenda,topicStats,topicsViz,sections}));observed[state]=value;
 if(!record&&!observe)expect(value).toEqual(expected[state]);
});
afterAll(()=>{if(observe){fs.writeFileSync(observe,JSON.stringify(observed,null,2)+'\n');return;}if(record)fs.writeFileSync(goldenPath,JSON.stringify(observed,null,2)+'\n');else expect(Object.keys(observed)).toEqual(Object.keys(golden));});
