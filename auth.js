/*
 * Local authentication prototype.
 * Replace authProvider.signIn with the company SSO/OIDC flow later.
 * The rest of the app consumes only the normalized session object.
 */
(function(){
  const SESSION_KEY='rr-auth-session';
  async function sendTelemetryBootstrap(){try{if(sessionStorage.getItem('rr-telemetry-app-open')==='sent')return;const response=await fetch('/api/bootstrap',{method:'GET',credentials:'same-origin'});if(response.ok)sessionStorage.setItem('rr-telemetry-app-open','sent')}catch{}}
  sendTelemetryBootstrap();
  const ROLE_LABELS={admin:'시스템 관리자',leader:'팀장',member:'팀원'};
  // 인사팀장만 팀장 권한을 가지며, 그룹 책임자는 그룹장 업무 범위로 처리한다.
  const ROLE_BY_MEMBER_ID={1:'leader'};
  ROLE_LABELS.groupLeader='그룹장';
  function roleForMember(member){
    if(!member)return 'member';
    const managedDepartment=(data.departments||[]).find(department=>department.manager===member.name);
    if(managedDepartment?.type==='그룹')return 'groupLeader';
    if(managedDepartment?.type==='팀'||ROLE_BY_MEMBER_ID[member.id]==='leader')return 'leader';
    return 'member';
  }
  const authProvider={
    async signIn(memberId){
      const member=data.members.find(m=>String(m.id)===String(memberId));
      if(!member)throw new Error('사용자를 찾을 수 없습니다.');
      const role=roleForMember(member);
      return {memberId:member.id,memberName:member.name,role,provider:'local',signedInAt:new Date().toISOString()};
    },
    signOut(){localStorage.removeItem(SESSION_KEY)}
  };
  function session(){try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}catch{return null}}
  function memberRole(memberId){return roleForMember(data.members.find(member=>String(member.id)===String(memberId)))}
  function roleLabel(role){return ROLE_LABELS[role]||ROLE_LABELS.member}
  function ensureLayer(){
    if(document.querySelector('.auth-layer'))return;
    const layer=document.createElement('div');layer.className='auth-layer';layer.id='authLayer';layer.hidden=true;
    layer.innerHTML=`<section class="auth-card" aria-labelledby="authTitle"><div class="auth-brand"><span class="auth-brand-mark">W</span><div><strong>WONIK IPS</strong><small>업무 현황판</small></div></div><p class="auth-eyebrow">LOCAL ACCESS</p><h1 id="authTitle">누구로 시작할까요?</h1><p class="auth-description">60일 검증 기간 동안은 사용자 선택으로 접속합니다. 선택한 권한에 맞는 업무 화면이 표시됩니다.</p><form id="authForm"><div class="auth-field"><label for="authMember">사용자</label><select id="authMember" name="memberId" required></select></div><button class="auth-submit" type="submit">업무 화면 시작</button></form><p class="auth-note">향후 회사 SSO 연동 시 이 화면의 인증 방식만 교체하고 업무 권한·화면 구조는 그대로 사용합니다.</p></section>`;
    document.body.appendChild(layer);
    const select=layer.querySelector('#authMember');
    data.members.forEach(member=>{const option=document.createElement('option');option.value=member.id;option.textContent=`${member.name} · ${roleLabel(memberRole(member.id))}`;select.appendChild(option)});
    layer.querySelector('#authForm').addEventListener('submit',async event=>{event.preventDefault();const form=new FormData(event.currentTarget);const next=await authProvider.signIn(form.get('memberId'));applySession(next);});
  }
  function applySession(next){
    const member=data.members.find(item=>String(item.id)===String(next.memberId));
    if(member)next={...next,memberName:member.name,role:roleForMember(member)};
    localStorage.setItem(SESSION_KEY,JSON.stringify(next));
    data.currentUser=next.memberName;data.currentUserRole=next.role;save();
    window.RR_CURRENT_USER=next.memberName;window.RR_IS_ADMIN=next.role==='admin';
    document.body.classList.remove('auth-locked');const layer=document.querySelector('.auth-layer');if(layer)layer.hidden=true;
    applyRoleNavigation(next.role);updateUserChrome(next);window.render();
  }
  function applyRoleNavigation(role){
    document.querySelectorAll('.nav-item').forEach(item=>{const view=item.dataset.view;const leaderRole=role==='leader'||role==='groupLeader';const allowed=role==='admin'||(leaderRole?view!=='admin':!['admin','records'].includes(view));item.hidden=!allowed});
    if(role!=='admin'&&['admin','records'].includes(current))window.go('dashboard');
  }
  function updateUserChrome(current){
    const actions=document.querySelector('.top-actions');if(!actions)return;
    let chip=document.querySelector('.auth-user-chip');if(!chip){chip=document.createElement('span');chip.className='auth-user-chip';actions.prepend(chip)}
    chip.innerHTML=`<strong>${esc(current.memberName)}</strong><span class="auth-role">${roleLabel(current.role)}</span>`;
    let logout=document.querySelector('.auth-logout');if(!logout){logout=document.createElement('button');logout.className='auth-logout';logout.type='button';logout.textContent='로그아웃';actions.prepend(logout);logout.addEventListener('click',()=>{authProvider.signOut();location.reload()})}
  }
  function showLogin(){ensureLayer();document.body.classList.add('auth-locked');const layer=document.querySelector('.auth-layer');layer.hidden=false;applyRoleNavigation('member')}
  window.RR_AUTH={session,signIn:authProvider.signIn,signOut:authProvider.signOut,roleLabel,showLogin};
  const currentSession=session();
  if(currentSession){applySession(currentSession)}else{showLogin()}
})();
