"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {assertCommentsAttempts, message} = require("./admission.cjs");
const policy = {template:"comment-moderation",count:1,pending:2,conversationId:"2generated",recipients:[{class:"owner",address:"Generated <owner@example.invalid>"}]};
const input=message(policy.recipients[0].address,2,policy.conversationId);
const attempts=[{service:"SESv2",command:"SendEmailCommand",input,termination:"end"},{host:"comments-ses",port:8025,protocol:"http",method:"POST",path:"/v2/email/outbound-emails",body:input,blocked:false,termination:"end"}];
test("only the declared template and recipient are admitted",()=>assertCommentsAttempts(attempts,policy));
test("zero attempts is an explicit policy",()=>assertCommentsAttempts([],{...policy,count:0,recipients:[]}));
for(const [name,edit] of [
 ["extra command",a=>a.push(a[0])],
 ["wrong recipient",a=>a[0].input.Destination.ToAddresses=["other@example.invalid"]],
 ["wrong template",a=>a[0].input.Content.Simple.Subject.Data="wrong"],
 ["cloud transport",a=>a[1].host="email.us-east-1.amazonaws.com"],
 ["wrong local port",a=>a[1].port=8026],
 ["wrong local path",a=>a[1].path="/anything"],
 ["failed transport",a=>a[1].termination="connection_error"],
 ["other service",a=>a.push({service:"SQS"})],
])test(name+" is refused",()=>{const a=structuredClone(attempts);edit(a);assert.throws(()=>assertCommentsAttempts(a,policy));});
test("missing policy is refused",()=>assert.throws(()=>assertCommentsAttempts([],undefined)));
test("raw sockets without a declared send are refused",()=>assert.throws(()=>assertCommentsAttempts([{host:"comments-ses",port:8025,protocol:"tcp",blocked:false}],{...policy,count:0,recipients:[]})));
