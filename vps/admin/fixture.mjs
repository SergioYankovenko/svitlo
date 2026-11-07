import {readFile} from 'node:fs/promises';
export async function adminFixture(c){
 await c.exec(`create role svitlo_stage_api;create role svitlo_stage_worker;create role svitlo_stage_session;create role svitlo_sensor_owner;create role svitlo_discovery_owner;
 create schema svitlo_sources;create schema svitlo_events;create schema svitlo_discovery;grant usage on schema svitlo_discovery to svitlo_discovery_owner;create schema svitlo_vps;create schema svitlo_sensors;create schema svitlo_catalog;create schema auth;
 create table auth.users(id uuid primary key,created_at timestamptz default now());create table svitlo_vps.sessions(token_hash text primary key,owner uuid,expires_at timestamptz);
 create table svitlo_sources.registry(id text primary key,label text,family text,verification_state text);create table svitlo_sources.state(source_id text,last_attempt_at timestamptz,last_success_at timestamptz,last_outcome text);
 create table svitlo_events.deliveries(id uuid,consumer text,state text,attempts integer,next_at timestamptz,error_code text,finished_at timestamptz);
 create function svitlo_events.replay_delivery(uuid,uuid,uuid,text) returns boolean language sql as $$select false$$;
 create table svitlo_discovery.regional_sources(operator_id text,enabled boolean,status text,last_attempt_at timestamptz,last_success_at timestamptz,next_at timestamptz,error_code text);alter table svitlo_discovery.regional_sources enable row level security;
 create table svitlo_catalog.binding_reviews(address_id uuid,reason text,state text,last_seen_at timestamptz,observations integer);
 create table svitlo_vps.worker_cycle(id boolean,last_attempt timestamptz,last_success timestamptz,last_failure timestamptz,error_code text);alter table svitlo_vps.worker_cycle enable row level security;
 create table svitlo_sensors.devices(sensor_id uuid primary key,status text,current_epoch integer,created_at timestamptz);alter table svitlo_sensors.devices enable row level security;
 create table svitlo_sensors.main_app_subscriptions(subject uuid,source text,valid_from timestamptz,valid_until timestamptz,revoked_at timestamptz);alter table svitlo_sensors.main_app_subscriptions enable row level security;
 create function svitlo_discovery.source_available_at(text) returns timestamptz language sql as $$select '-infinity'::timestamptz$$;alter function svitlo_discovery.source_available_at(text) owner to svitlo_discovery_owner;
 grant usage on schema svitlo_sensors to svitlo_sensor_owner,svitlo_stage_api;
 create function svitlo_sensors.phone_ingest(jsonb,text) returns jsonb language sql as $$select '{"http":200,"acknowledged":true}'::jsonb$$;alter function svitlo_sensors.phone_ingest(jsonb,text) owner to svitlo_sensor_owner;
 create function svitlo_sensors.ingest(jsonb,text) returns jsonb language sql as $$select '{"http":200,"acknowledged":true}'::jsonb$$;alter function svitlo_sensors.ingest(jsonb,text) owner to svitlo_sensor_owner;
 `);
 await c.exec(await readFile(new URL('../sql/admin-control.sql',import.meta.url),'utf8'));
}
