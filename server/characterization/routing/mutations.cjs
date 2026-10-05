module.exports=[
 {name:'owner-filter-truthiness',file:'comment.ts',from:"if (!_.isUndefined(o.not_voted_by_pid)) {\n          // 'SELECT",to:"if (!!o.not_voted_by_pid) {\n          // 'SELECT"},
 {name:'owner-route-truthiness',file:'routes/comments.ts',from:'req.p.pid ?? req.p.not_voted_by_pid',to:'req.p.pid || req.p.not_voted_by_pid'},
 {name:'ignore-engine-priority',file:'nextComment.ts',from:'priorities[comment.tid] || 1',to:'1'},
 {name:'zero-weight-is-zero',file:'nextComment.ts',from:'priorities[comment.tid] || 1',to:'priorities[comment.tid] ?? 1'},
 {name:'disable-topical',file:'nextComment.ts',from:'Math.random() < ratio',to:'false'},
 {name:'remove-math-read',file:'nextComment.ts',from:'getLatestExistingPca(zid),',to:'Promise.resolve(null),'},
 {name:'ignore-without',file:'nextComment.ts',from:'params.withoutTids = withoutTids;',to:'params.withoutTids = [];'},
 {name:'window-1000',file:'comment.ts',from:'q.limit(999)',to:'q.limit(1000)'},
 {name:'remove-seed-first',file:'comment.ts',from:'if (conv.prioritize_seed)',to:'if (false)'},
 {name:'disable-assignment-cache',file:'utils/commentClusters.ts',from:'const cached = clusterAssignmentsCache.get(zid);',to:'const cached = undefined;'},
 {name:'disable-math-cache',file:'utils/pca.ts',from:'let cached = pcaCache.get(pcaCacheKey(mathEnv, zid));',to:'let cached = undefined;'},
 {name:'skip-translations',file:'nextComment.ts',from:'await ensureTranslations(zid!, next, lang);',to:'await ensureTranslations(zid!, next);'},
];
