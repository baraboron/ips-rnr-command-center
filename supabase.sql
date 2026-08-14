-- 팀 Supabase 프로젝트에서 1회 실행
create table if not exists kpi_metric (id bigint generated always as identity primary key, name text not null, kind text not null check (kind in ('quant','qual')), unit text, target numeric, method text);
create table if not exists kpi_entry (id bigint generated always as identity primary key, metric_id bigint not null references kpi_metric(id), value numeric not null, recorded_on date not null, note text);
create table if not exists kpi_note (id bigint generated always as identity primary key, metric_id bigint not null references kpi_metric(id), content text, photo_url text, recorded_on date not null);
create table if not exists rr_department (id text primary key, name text not null, department_type text not null check (department_type in ('본부','팀','그룹')), parent_id text references rr_department(id), manager_name text, created_at timestamptz default now());
create index if not exists rr_department_parent_idx on rr_department(parent_id);
insert into rr_department (id,name,department_type,parent_id,manager_name) values
  ('team-hr','인사팀','팀',null,'김민정'),
  ('group-hr-g','인사G','그룹','team-hr','오세훈'),
  ('group-education-g','교육G','그룹','team-hr','이수진'),
  ('group-general-affairs-g','총무G','그룹','team-hr','박현우'),
  ('group-recruiting-g','채용G','그룹','team-hr','최유나')
on conflict (id) do update set name=excluded.name, department_type=excluded.department_type, parent_id=excluded.parent_id, manager_name=excluded.manager_name;
create table if not exists rr_member (id bigint generated always as identity primary key, name text not null unique, level text not null, skills text[] default '{}', experience numeric default 0, workload numeric default 0 check (workload between 0 and 100));
alter table rr_member add column if not exists task_types text[] default '{}';
alter table rr_member add column if not exists department_id text references rr_department(id);
alter table rr_member add column if not exists max_workload numeric default 85;
alter table rr_member add column if not exists profile_source text default 'grade_default';
alter table rr_member add column if not exists capacity_hours numeric default 24;
alter table rr_member add column if not exists availability numeric default 1 check (availability between 0.25 and 1);
create table if not exists rr_task (id bigint generated always as identity primary key, title text not null, description text, created_by text not null, owner_name text, due_on date, status text not null default 'unassigned' check (status in ('unassigned','assigned','in_progress','blocked','done')), required_level text, required_skills text[] default '{}', min_experience numeric default 0, estimated_hours numeric default 0, collaborators text[] default '{}', created_at timestamptz default now());
alter table rr_task add column if not exists requesting_department_id text references rr_department(id);
alter table rr_task add column if not exists target_department_id text references rr_department(id);
alter table rr_task add column if not exists assignment_scope text default 'member' check (assignment_scope in ('department','member'));
alter table rr_task add column if not exists department_assigned boolean default false;
alter table rr_task add column if not exists task_type text default '교육 운영';
alter table rr_task add column if not exists difficulty text default '선임';
alter table rr_task add column if not exists assignment_mode text default 'single' check (assignment_mode in ('single','multi'));
alter table rr_task add column if not exists required_assignees integer default 1 check (required_assignees between 1 and 10);
create table if not exists rr_task_assignee (id bigint generated always as identity primary key, task_id bigint not null references rr_task(id) on delete cascade, member_name text not null, role text not null default 'co_assignee' check (role in ('primary','co_assignee')), assigned_by text, assigned_at timestamptz default now(), unique(task_id, member_name));
create index if not exists rr_task_assignee_task_idx on rr_task_assignee(task_id);
create index if not exists rr_task_assignee_member_idx on rr_task_assignee(member_name);
create table if not exists rr_assignment_history (id bigint generated always as identity primary key, task_id bigint not null references rr_task(id) on delete cascade, previous_owner text, new_owner text, changed_by text, changed_at timestamptz default now());
alter table rr_assignment_history add column if not exists previous_department_id text;
alter table rr_assignment_history add column if not exists new_department_id text;
alter table rr_assignment_history add column if not exists previous_owners text[] default '{}';
alter table rr_assignment_history add column if not exists new_owners text[] default '{}';
create table if not exists rr_task_edit_history (id bigint generated always as identity primary key, task_id bigint not null references rr_task(id) on delete cascade, changed_fields text[] default '{}', previous_data jsonb, new_data jsonb, reason text not null, changed_by text, changed_at timestamptz default now());
create table if not exists rr_task_satisfaction (id bigint generated always as identity primary key, task_id bigint not null references rr_task(id) on delete cascade, owner_name text, submitted_by text, fit text, workload_feedback text, challenge_preference text, comment text, recorded_on date not null default current_date);
alter table rr_task_satisfaction add column if not exists submitted_by text;
create table if not exists rr_member_role (id bigint generated always as identity primary key, member_name text not null, area text not null, task_id bigint references rr_task(id) on delete cascade);
insert into kpi_metric (name,kind,unit,target,method) select '담당이 정해진 비율','quant','%',80,'담당이 정해지지 않은 업무 카드의 비율을 주마다 확인' where not exists (select 1 from kpi_metric where name='담당이 정해진 비율');
insert into kpi_metric (name,kind,unit,target,method) select '업무 배정 완료율','quant','%',100,'등록된 업무 중 담당자와 기한이 지정된 업무 비율' where not exists (select 1 from kpi_metric where name='업무 배정 완료율');
insert into kpi_metric (name,kind,unit,target,method) select '평균 담당자 배정 시간','quant','일',1,'업무 등록 후 담당자 지정까지 걸린 평균 시간' where not exists (select 1 from kpi_metric where name='평균 담당자 배정 시간');
insert into kpi_metric (name,kind,unit,target,method) select '업무 배정 적합도','quant','점',4,'업무량과 난이도의 적절성에 대한 구성원 평균 점수' where not exists (select 1 from kpi_metric where name='업무 배정 적합도');
insert into kpi_metric (name,kind,method) select '정성 기록','qual','사진과 글로 개선 사례를 계속 기록' where not exists (select 1 from kpi_metric where name='정성 기록');
