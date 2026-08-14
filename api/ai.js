const OPENAI_URL = 'https://api.openai.com/v1/responses';

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function promptFor(action, input) {
  const base = '너는 회사 내부 R&R 업무관리 서비스의 AI 보조자다. 입력 데이터에 없는 사실은 만들지 말고, 숫자와 이름은 제공된 데이터만 사용한다. 한국어로 명확하고 실무적으로 답한다.';
  if (action === 'department_report') return `${base}
부서장 대상 현재 부서 관리 레포트를 작성하라.
반드시 다음 순서로 작성한다:
1. 한 줄 요약
2. 업무부하가 높은 직원과 근거(담당 업무 수, 진행 업무, 예상 시간, 부하율)
3. 부서 전반 과중 상태(정상/주의/과중 중 하나와 근거)
4. 즉시 조치 3가지
5. 부서장이 확인할 질문
추측, 인사평가, 낙인 표현은 금지한다. 데이터가 부족하면 부족하다고 표시한다.

부서 정보:
${JSON.stringify(input, null, 2)}`;
  if (action === 'complete_task') return `${base}
사용자가 짧게 작성한 업무 내용을 실무 명세로 확장하라.
다음 형식을 지킨다:
업무 목적: ...
주요 내용:
- ...
산출물: ...
완료 기준:
- ...
협업/확인 필요: ...
입력에 없는 일정·수치·담당자를 확정하지 말고 '확인 필요'로 표시한다.

업무 입력:
${JSON.stringify(input, null, 2)}`;
  if (action === 'briefing') return `${base}
부서원이 자신의 업무 결과를 회고할 수 있는 ${input.period === 'monthly' ? '월간' : '주간'} 브리핑을 작성하라.
반드시 다음 순서로 작성한다:
1. 기간 요약
2. 완료한 업무
3. 진행 중·지연·막힌 업무
4. 수치로 보는 결과
5. 다음 기간 우선순위 3가지
6. 지원이 필요한 사항
완료되지 않은 업무를 완료로 표현하지 말고, 데이터가 없으면 없다고 표시한다.

사용자 및 업무 데이터:
${JSON.stringify(input, null, 2)}`;
  throw new Error('지원하지 않는 AI 작업입니다.');
}

function outputText(response) {
  if (response && typeof response.output_text === 'string') return response.output_text;
  return (response?.output || []).flatMap(item => item.content || []).map(part => part.text || '').join('\n').trim();
}

async function handler(req, res) {
  if (req.method !== 'POST') return json(res, 405, {error:'POST 요청만 허용됩니다.'});
  if (!process.env.OPENAI_API_KEY) return json(res, 503, {error:'OPENAI_API_KEY가 서버 환경변수에 없습니다.'});
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const action = String(body.action || '');
    const input = body.input || {};
    const response = await fetch(OPENAI_URL, {
      method:'POST',
      headers:{'Content-Type':'application/json',Authorization:`Bearer ${process.env.OPENAI_API_KEY}`},
      body:JSON.stringify({model:process.env.OPENAI_MODEL || 'gpt-5.6-luna',input:promptFor(action,input),store:false})
    });
    const result = await response.json();
    if (!response.ok) return json(res, response.status, {error:result?.error?.message || 'OpenAI API 호출에 실패했습니다.'});
    return json(res, 200, {text:outputText(result),model:result.model});
  } catch (error) {
    return json(res, 400, {error:error.message || 'AI 요청을 처리하지 못했습니다.'});
  }
}

module.exports = handler;
