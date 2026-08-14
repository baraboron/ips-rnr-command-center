/* Remote persistence for the local-auth prototype. */
(function(){
  let url=window.RR_SUPABASE_URL||'';
  let key=window.RR_SUPABASE_ANON_KEY||'';
  let table=`${url}/rest/v1/rr_app_state`;
  let timer=null;
  const headers={apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'};
  async function request(path='',options={}){const r=await fetch(`${table}${path}`,{...options,headers:{...headers,...(options.headers||{})}});if(!r.ok)throw new Error(`Supabase ${r.status}`);return r;}
  function status(text){const node=document.querySelector('#syncStatus');if(node)node.textContent=text;}
  async function push(state){if(!url||!key)return;await request('',{method:'POST',headers:{...headers,Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify({id:'default',payload:state,updated_at:new Date().toISOString()})});status('Supabase에 저장됨');}
  async function load(){try{if(!url||!key){const config=await fetch('/api/config').then(r=>r.ok?r.json():null);url=config?.supabaseUrl||'';key=config?.supabaseAnonKey||'';table=`${url}/rest/v1/rr_app_state`;window.RR_SUPABASE_URL=url;window.RR_SUPABASE_ANON_KEY=key;}if(!url||!key){status('로컬 기록으로 동작 중');return}const r=await request('?id=eq.default&select=payload');const rows=await r.json();if(rows[0]?.payload){window.RR_APP.setData(rows[0].payload);localStorage.setItem('rr-board-data',JSON.stringify(rows[0].payload));window.render();status('Supabase에서 불러옴')}else{await push(window.RR_APP.getData());status('Supabase에 초기 데이터 저장됨')}}catch(error){console.error(error);status('Supabase 연결 실패 · 로컬 기록 사용');}}
  window.RR_SUPABASE_SYNC={schedule(state){if(!url||!key)return;clearTimeout(timer);timer=setTimeout(()=>push(state).catch(error=>{console.error(error);status('Supabase 저장 실패')}),250)},load};
  window.addEventListener('DOMContentLoaded',()=>load());
})();
