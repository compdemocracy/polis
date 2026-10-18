'use strict';
// End-of-phase digest of the disposable fixture database, read from stdin by
// `node -` inside the server container. Per public table (except the schema
// bookkeeping tables): the row count, an md5 of every row's text ordered by
// primary key, and an md5 per column. Prints digests only, never values.
const {Pool}=require('/app/node_modules/pg');
const quote=name=>'"'+name.replaceAll('"','""')+'"';
(async()=>{
 if(new URL(process.env.DATABASE_URL).pathname!='/p027')throw Error('disposable database required');
 const p=new Pool({connectionString:process.env.DATABASE_URL});
 const tables=(await p.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename NOT IN ('vote_convention','schema_migrations') ORDER BY tablename")).rows.map(r=>r.tablename);
 const out={};
 for(const table of tables){
  const key=(await p.query("SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=$1::regclass AND i.indisprimary ORDER BY array_position(i.indkey,a.attnum)",[quote(table)])).rows.map(r=>'t.'+quote(r.attname));
  const columns=(await p.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",[table])).rows.map(r=>r.column_name);
  const order=key.length?key.join(','):'t::text';
  const parts=[`count(*)::int AS "rows"`,`md5(coalesce(string_agg(t::text,E'\\n' ORDER BY ${order}),'')) AS "row"`,
   ...columns.map((c,i)=>`md5(coalesce(string_agg(coalesce(t.${quote(c)}::text,'<null>'),E'\\n' ORDER BY ${order}),'')) AS "c${i}"`)];
  const r=(await p.query(`SELECT ${parts.join(',')} FROM ${quote(table)} t`)).rows[0];
  out[table]={rows:r.rows,digest:r.row,columns:Object.fromEntries(columns.map((c,i)=>[c,r['c'+i]])),ordered_by:key.length?'primary key':'row text'};
 }
 await p.end();
 console.log(JSON.stringify(out));
})().catch(error=>{console.error(JSON.stringify({stage:'digest',code:error.code}));process.exit(1)});
