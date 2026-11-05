// Disposable restored databases only. This helper is never imported by runtime.
export async function enableQaSubscriptions(admin,subjects){
 if(!/^svitlo_(phone|history|map|kyiv|subscriptions)_qa_\d+$/.test(process.env.PGDATABASE||''))throw Error('Disposable subscription QA database required');
 if(!Array.isArray(subjects)||!subjects.length||subjects.length>20||new Set(subjects).size!==subjects.length||subjects.some(s=>typeof s!=='string'||! /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(s)))throw Error('Explicit QA subjects required');
 const users=(await admin.query('select count(*)::int n from auth.users where id=any($1::uuid[])',[subjects])).rows[0].n;
 if(users!==subjects.length)throw Error('QA subjects must already exist');
 await admin.query("insert into svitlo_sensors.main_app_subscriptions(subject,source,valid_from,valid_until) select subject,'private_test',clock_timestamp()-interval '1 minute',clock_timestamp()+interval '1 hour' from unnest($1::uuid[]) as subjects(subject)",[subjects]);
}
