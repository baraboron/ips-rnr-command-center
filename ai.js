(function(){
  const roleLabel={admin:'시스템 관리자',leader:'팀장',member:'팀원'};
  let activeTab='briefing';
  const $=s=>document.querySelector(s);
  const esc=s=>String(s??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function current(){return window.RR_AUTH?.session?.()||null}
  function role(){return current()?.role||'member'}
  function member(){const s=current();return data.members.find(m=>String(m.id)===String(s?.memberId))||data.members.find(m=>m.name===currentUserName())}
  function api(action,input){return fetch('/api/ai',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action,input})}).then(async r=>{const body=await r.json();if(!r.ok)throw new Error(body.error||'AI 요청에 실패했습니다.');return body})}
  function ensureLauncher(){
    const actions=$('.top-actions');if(!actions||$('.ai-launcher'))return;
    const button=document.createElement('button');button.className='ai-launcher visible';button.type='button';button.innerHTML='✦ AI 도우미';button.addEventListener('click',()=>openAiModal());actions.prepend(button);
  }
  function ensureModal(){
    if($('.ai-modal'))return;
    const modal=document.createElement('div');modal.className='ai-modal';modal.hidden=true;modal.innerHTML='<section class="ai-panel" role="dialog" aria-modal="true" aria-labelledby="aiTitle"><div class="ai-panel-head"><div><p class="eyebrow">WORK SMARTER</p><h2 id="aiTitle">AI 업무 도우미</h2><p class="ai-context-note">입력된 업무 데이터만 바탕으로 초안을 만듭니다.</p></div><button class="ai-close" type="button" aria-label="닫기">×</button></div><div class="ai-tabs"></div><div class="ai-content"></div><div class="ai-result" aria-live="polite"></div></section>';
    document.body.appendChild(modal);modal.querySelector('.ai-close').onclick=()=>modal.hidden=true;modal.addEventListener('click',e=>{if(e.target===modal)modal.hidden=true});
  }
  function tabs(){
    const list=[];if(role()==='admin'||role()==='leader')list.push(['department','부서 관리 레포트']);list.push(['briefing','주간·월간 브리핑']);list.push(['complete','업무 명세 보완']);return list;
  }
  function renderTabs(){const box=$('.ai-tabs');box.innerHTML=tabs().map(([id,label])=>`<button class="ai-tab ${id===activeTab?'active':''}" type="button" data-ai-tab="${id}">${label}</button>`).join('');box.querySelectorAll('[data-ai-tab]').forEach(b=>b.onclick=()=>{activeTab=b.dataset.aiTab;renderContent()})}
  function renderContent(){
    ensureModal();renderTabs();const content=$('.ai-content');$('.ai-result').textContent='';
    if(activeTab==='department')content.innerHTML='<form class="ai-form" id="aiDepartmentForm"><label>보고서 기준<select name="focus"><option value="all">전체 부서 현황</option><option value="risk">부하 위험 중심</option><option value="action">즉시 조치 중심</option></select></label><button class="ai-submit" type="submit">부서 관리 레포트 생성</button></form>';
    if(activeTab==='briefing')content.innerHTML='<form class="ai-form" id="aiBriefingForm"><label>브리핑 기간<select name="period"><option value="weekly">주간</option><option value="monthly">월간</option></select></label><button class="ai-submit" type="submit">업무 결과 브리핑 생성</button></form>';
    if(activeTab==='complete')content.innerHTML='<form class="ai-form" id="aiCompleteForm"><label>업무명<input name="title" required placeholder="예: 신입사원 입문교육 개선"></label><label>짧은 업무 설명<textarea name="description" required placeholder="현재 알고 있는 내용만 몇 마디로 적어주세요."></textarea></label><label>업무 유형<input name="taskType" placeholder="예: 교육 운영"></label><button class="ai-submit" type="submit">업무 명세 초안 만들기</button></form>';
    bindForm();
  }
  function result(text){$('.ai-result').classList.remove('ai-error');$('.ai-result').textContent=text||'생성된 내용이 없습니다.'}
  function error(err){$('.ai-result').classList.add('ai-error');$('.ai-result').textContent=err.message||String(err)}
  function setBusy(form,busy){const button=form.querySelector('.ai-submit');if(button){button.disabled=busy;button.textContent=busy?'생성 중…':'다시 생성'}}
  function departmentInput(focus){
    const me=member();const managed=data.departments?.find(d=>d.manager===currentUserName())||data.departments?.find(d=>d.id===me?.departmentId);const ids=new Set((data.departments||[]).filter(d=>managed?d.id===managed.id||String(d.parentId)===String(managed.id):true).map(d=>d.id));const members=data.members.filter(m=>!managed||ids.has(m.departmentId));const names=new Set(members.map(m=>m.name));const tasks=data.tasks.filter(t=>!managed||t.targetDepartmentId&&ids.has(t.targetDepartmentId)||taskAssigneeNames(t).some(n=>names.has(n)));return {focus,manager:currentUserName(),department:managed?.name||'전체 부서',members:members.map(m=>({name:m.name,level:m.level,workload:calculatedWorkload(m),capacityHours:m.capacityHours,availability:m.availability})),tasks:tasks.map(t=>({title:t.title,status:t.status,owner:t.owner,assignees:taskAssigneeNames(t),estimatedHours:t.estimatedHours,due:t.due}))};
  }
  function briefingInput(period){const me=member();const name=me?.name||currentUserName();const tasks=data.tasks.filter(t=>taskAssigneeNames(t).includes(name)||t.owner===name);return {period,user:name,role:roleLabel[role()],tasks:tasks.map(t=>({title:t.title,status:t.status,due:t.due,estimatedHours:t.estimatedHours,taskType:t.taskType})),records:[...data.entries.map(x=>({...x,type:'정량'})),...data.notes.map(x=>({...x,type:'정성'}))].filter(x=>x.owner===name||!x.owner).slice(-20)} }
  function bindForm(){
    $('#aiDepartmentForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(e.currentTarget,true);try{result((await api('department_report',departmentInput(String(f.get('focus'))))).text)}catch(err){error(err)}finally{setBusy(e.currentTarget,false)}});
    $('#aiBriefingForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(e.currentTarget,true);try{result((await api('briefing',briefingInput(String(f.get('period'))))).text)}catch(err){error(err)}finally{setBusy(e.currentTarget,false)}});
    $('#aiCompleteForm')?.addEventListener('submit',async e=>{e.preventDefault();const f=new FormData(e.currentTarget);setBusy(e.currentTarget,true);try{result((await api('complete_task',{title:String(f.get('title')),description:String(f.get('description')),taskType:String(f.get('taskType')),user:currentUserName()})).text)}catch(err){error(err)}finally{setBusy(e.currentTarget,false)}});
  }
  function openAiModal(tab){ensureModal();activeTab=tab||((role()==='admin'||role()==='leader')?'department':'briefing');$('.ai-modal').hidden=false;renderContent()}
  function addTaskHelper(){
    const textarea=document.querySelector('.task-modal textarea[name="description"], .edit-task-modal textarea[name="description"]');if(!textarea||textarea.parentElement.querySelector('.ai-inline-help'))return;
    const wrap=document.createElement('div');wrap.className='ai-inline-help';wrap.innerHTML='<span class="ai-context-note">짧게 적은 업무 설명을 AI가 명세 초안으로 확장합니다.</span><button type="button" class="ai-fill-button">✦ AI 명세 보완</button>';textarea.parentElement.appendChild(wrap);wrap.querySelector('button').onclick=async()=>{const title=document.querySelector('.task-modal input[name="title"], .edit-task-modal input[name="title"]')?.value||'';if(!title&&!textarea.value.trim())return toast('업무명 또는 설명을 먼저 입력해 주세요.');const button=wrap.querySelector('button');button.disabled=true;button.textContent='생성 중…';try{const out=await api('complete_task',{title,description:textarea.value,taskType:document.querySelector('.task-modal select[name="taskType"]')?.value||'',user:currentUserName()});textarea.value=out.text;textarea.dispatchEvent(new Event('input',{bubbles:true}));toast('AI가 업무 명세 초안을 채웠습니다. 내용을 확인해 주세요.')}catch(err){toast(err.message||'AI 요청에 실패했습니다.')}finally{button.disabled=false;button.textContent='✦ AI 명세 보완'}};
  }
  ensureLauncher();ensureModal();new MutationObserver(()=>{ensureLauncher();addTaskHelper()}).observe(document.body,{childList:true,subtree:true});
  window.RR_AI={open:openAiModal,request:api};
})();
