'use strict';
const $ = id => document.getElementById(id);
// Matches the cloud database limit; the local server still runs one job at a time and says so.
const MAX_ACTIVE_JOBS=3;
const state = {config:null, category:'', company:null, search:null, report:null, reportId:null, jobs:[], busy:false, searchRevision:0,financialRevision:0,jobsRevision:0,companyRevision:0,analysisJob:null};
const labels = {search:'소재 검색', companies:'회사 찾기', financial:'재무 분석', batch:'다중 비교', collect:'원문 수집',library:'분석 보관함'};
state.searchPage=1;state.libraryPage=1;state.libraryRevision=0;state.comparison=new Map();
// Companies picked for the multi-company financial view (cloud only).
state.picks=new Map();state.batch=null;state.batchRevision=0;
const MAX_PICKS=100;
const batchEnabled=()=>typeof window.dartCloudBatch==='function';
const metrics = {
  revenue:'매출액',cost:'매출원가',gross:'매출총이익',sga:'판매비와관리비',operating:'영업이익',margin:'영업이익률',
  depreciation:'유형자산 감가상각비',amortization:'무형자산 상각비',ebitda:'EBITDA',netIncome:'당기순이익',
  assets:'자산총계',cash:'현금및현금성자산',liabilities:'부채총계',equity:'자본총계',liabilityRatio:'부채비율',
  liabilitiesLessCash:'부채총계−현금(참고)',liabilitiesLessCashRatio:'(부채−현금)/자본',operatingCash:'영업활동현금흐름',growth:'매출 증가율(전년 동기)'
};
const percent = new Set(['margin','liabilityRatio','liabilitiesLessCashRatio','growth']);
const major = new Set(['revenue','operating','margin','ebitda','netIncome','equity']);
const formula = {margin:'영업이익 ÷ 매출액 × 100',liabilityRatio:'부채총계 ÷ 자본총계 × 100',
  liabilitiesLessCash:'부채총계 − 현금및현금성자산',liabilitiesLessCashRatio:'(부채총계 − 현금및현금성자산) ÷ 자본총계 × 100',
  ebitda:'영업이익 + 유형자산 감가상각비 + 무형자산 상각비',growth:'(매출액 − 전년 동기 매출액) ÷ 전년 동기 매출액 × 100'};

function el(tag, className='', text='') {
  const node=document.createElement(tag); if(className)node.className=className; node.textContent=text; return node;
}
function button(text, onClick, className='outline') {
  const b=el('button',className,text); b.type='button'; b.addEventListener('click',onClick); return b;
}
function notify(message='') {$('notice').textContent=message; $('notice').classList.toggle('hidden',!message);}
function page(name) {
  if(!labels[name])return;
  document.querySelectorAll('.page').forEach(n=>n.classList.toggle('hidden',n.id!==`page-${name}`));
  document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.page===name));
  $('page-label').textContent=labels[name];
  if(name==='library')loadLibrary().catch(e=>notify(e.message));
  renderPicks();
}
async function api(path, data, {signal}={}) {
  if(window.dartCloudApi)return window.dartCloudApi(path,data);
  const response=await fetch(path,{method:data===undefined?'GET':'POST',credentials:'same-origin',signal,
    headers:data===undefined?{}:{'Content-Type':'application/json'},body:data===undefined?undefined:JSON.stringify(data)});
  const payload=await response.json();
  if(!response.ok) {
    if(response.status===401 && path!=='/api/login')showLogin();
    throw new Error(payload.error || '요청 처리에 실패했습니다.');
  }
  return payload;
}
function showLogin() {$('app').classList.add('hidden'); $('login-screen').classList.remove('hidden');}
async function initialize() {
  state.config=await api('/api/config');
  $('login-screen').classList.add('hidden'); $('app').classList.remove('hidden');
  $('stat-companies').textContent=state.config.indexedCompanies.toLocaleString();
  $('stat-reports').textContent=state.config.indexedReports.toLocaleString();
  $('stat-categories').textContent=Object.keys(state.config.categories).length;
  const year=Number(state.config.today.slice(0,4));
  if(!$('start-date').value)$('start-date').value=`${year}-01-01`;
  if(!$('end-date').value)$('end-date').value=state.config.today;
  $('start-date').max=state.config.today; $('end-date').max=state.config.today;
  $('last-year').max=year-1;
  if(!$('last-year').value)$('last-year').value=year-1;
  $('batch-year').max=year-1;if(!$('batch-year').value)$('batch-year').value=year-1;
  for(const id of ['nav-batch','pick-all'])$(id).classList.toggle('hidden',!batchEnabled());
  renderPicks();
  renderCategories();
  await Promise.all([search(),refreshJobs(true)]);
}
function renderCategories() {
  $('categories').replaceChildren();
  for(const name of ['',...Object.keys(state.config.categories)]) {
    const chip=button(name||'전체 소재',()=>{state.category=name;renderCategories(); search().catch(e=>notify(e.message));},'chip'+(state.category===name?' active':''));
    chip.setAttribute('aria-pressed',String(state.category===name)); $('categories').append(chip);
  }
}
async function search(requestedPage=1) {
  const revision=++state.searchRevision;
  const params=new URLSearchParams({q:$('query').value.trim(),category:state.category,page:requestedPage,sort:$('search-sort').value});
  $('search-scope').textContent='공식 회사·제품 목록에서 검색 중…';
  const data=await api('/api/discover?'+params);
  if(revision!==state.searchRevision)return;
  state.search=data; renderResults(data);
  state.searchPage=data.page;
  pagination('search-pagination',data.page,data.pages,p=>search(p).catch(e=>notify(e.message)));
  $('stat-companies').textContent=data.catalogCompanies.toLocaleString();
  $('stat-reports').textContent=data.scope.indexedReports.toLocaleString();
}
function renderResults(data) {
  $('result-count').textContent=data.companyCount.toLocaleString();
  $('search-scope').textContent=`제품 목록 ${data.catalogCompanies}개사 · 저장 원문 ${data.scope.indexedReports}건`+(data.expandedTerms?.length>1?' · 동의어 포함':'')+` · ${data.page}/${data.pages}페이지`;
  $('catalog-status').textContent=data.warning || '';
  const list=$('search-results'); list.replaceChildren();
  if(!data.companies.length) {
    const card=el('div','empty');
    card.append(el('p','eyebrow',data.scope.indexedReports?'NO MATCHES IN COLLECTED REPORTS':'YOUR LIBRARY STARTS HERE'));
    card.append(el('h2','',data.warning?'회사 목록 일부를 불러오지 못했습니다.':'일치하는 회사 후보를 찾지 못했습니다.'));
    card.append(el('p','','다른 제품명·영문명으로 검색하거나 회사명 찾기를 이용하세요. 목록에 없는 사업이 없다는 뜻은 아닙니다.'));
    card.append(button('솔브레인으로 실제 조회 →',()=>{page('companies');$('company-query').value='솔브레인'; lookupCompanies().catch(e=>notify(e.message));}));
    list.append(card);return;
  }
  for(const company of data.companies) {
    const card=companyCard(company.name,company.code);
    const tags=el('div','tag-row'); company.categories.forEach(c=>tags.append(el('span','tag',c))); card.append(tags);
    if(company.research?.status && company.research.status!=='unreviewed')tags.append(el('span','tag','사용자 검토: '+({confirmed:'제조판매 확인',mention:'언급만 확인',exclude:'제외로 표시'})[company.research.status]));
    const first=company.evidence[0];
    const preview=(company.catalogEvidence?.products || first?.text || '').replace(/\s+/g,' ');
    const terms=company.catalogEvidence?.matchedWords || first?.words || [];
    const positions=terms.map(w=>preview.toLowerCase().indexOf(w.toLowerCase())).filter(i=>i>=0);
    const position=positions.length?Math.min(...positions):0;
    card.append(el('p','excerpt',preview.slice(Math.max(0,position-30),Math.max(0,position-30)+150)+'…'));
    const footer=el('div','card-footer');footer.append(el('span','',company.catalogEvidence?`KRX 주요제품 후보 · 저장 공시 ${company.reportCount}건`:`공시 근거 ${company.evidenceCount}개 · 보고서 ${company.reportCount}건`));
    footer.append(button('근거 보기 ↗',()=>showEvidence(company),'text-button'));card.append(footer);
    const actions=el('div','card-actions');
    actions.append(button('선택하고 자동 분석 →',()=>analyzeCompany({name:company.name,code:company.code}).catch(e=>notify(e.message)),'primary'));
    if(batchEnabled())actions.append(pickButton({name:company.name,code:company.code,stock:company.stock||''}));
    actions.append(button('재무표 원문',()=>showCompanyRaw(company.code,company.name).catch(e=>notify(e.message))));
    actions.append(button(company.research?.favorite?'★ 관심·메모':'☆ 관심·메모',()=>editResearch(company.code,company.name).catch(e=>notify(e.message))));
    card.append(actions);list.append(card);
  }
}
function companyCard(name,code,stock='') {
  const card=el('article','company-card'),top=el('div','card-top'),title=el('div');
  title.append(el('h3','',name),el('small','',stock?`종목코드 ${stock} · DART ${code}`:`DART ${code}`));
  top.append(el('span','company-symbol',name[0]),title);card.append(top);return card;
}
async function lookupCompanies() {
  const revision=++state.companyRevision;
  const q=$('company-query').value.trim();if(!q)return;
  $('company-status').textContent='DART 공식 회사 목록을 확인하고 있습니다…';
  $('company-results').replaceChildren();
  const data=await api('/api/companies?'+new URLSearchParams({q}));
  if(revision!==state.companyRevision)return;
  $('company-status').textContent=`일치하는 회사 ${data.companies.length}개 · 이름이 비슷한 회사와 종목코드를 확인하세요.`;
  for(const c of data.companies) {
    const card=companyCard(c.name,c.code,c.stock),actions=el('div','card-actions');
    card.append(el('p','excerpt',c.stock?'구조화된 재무정보와 공시 원문을 조회합니다.':'구조화 재무정보 미제공 시 감사보고서 원문을 확인하세요.'));
    actions.append(button('선택하고 자동 분석 →',()=>analyzeCompany(c).catch(e=>notify(e.message)),'primary'));
    if(batchEnabled())actions.append(pickButton({name:c.name,code:c.code,stock:c.stock||''}));
    if(!window.dartCloudApi)actions.append(button('공시 원문 수집',()=>{selectCompany(c);$('scan-scope').value='selected';page('collect');}));
    actions.append(button('수집한 재무표',()=>showCompanyRaw(c.code,c.name).catch(e=>notify(e.message))));
    card.append(actions);$('company-results').append(card);
  }
  if(!data.companies.length)$('company-results').append(el('div','empty','회사명 또는 종목코드를 확인하세요. DART에 등록된 회사만 대상입니다.'));
}
function selectCompany(company) {
  state.financialRevision++;
  state.company=company;state.report=null;state.reportId=null;
  $('selected-company').value=`${company.name} (${company.code})`;
  $('scan-company').textContent=`선택한 회사: ${company.name} · ${company.code}`;
  $('financial-title').textContent=`${company.name} · 재무 분석`;
  $('financial-content').replaceChildren(el('h2','',`${company.name}의 재무정보를 조회할 수 있습니다.`),el('p','',"기준과 마지막 사업연도를 확인하면 공시 수집부터 재무 분석까지 이어집니다."));
  $('financial-content').className='panel empty';page('financial');
}
async function analyzeCompany(company) {
  if(state.busy){notify(`분석은 동시에 ${MAX_ACTIVE_JOBS}개까지 실행할 수 있습니다. 하나가 끝나거나 중지한 뒤 다시 시도하세요.`);return;}
  selectCompany(company);
  $('financial-content').replaceChildren(el('h2','',`${company.name} · 공시 원문 수집 중`),el('p','','사업보고서 또는 감사보고서를 모은 뒤 5개년 재무·제품 매출 분석을 자동으로 시작합니다. 아래 진행 상태를 확인하세요.'));
  try{await startJob('analyze',{code:company.code,basis:$('basis').value,year:Number($('last-year').value)});}
  catch(error){$('financial-content').replaceChildren(el('h2','','분석을 시작하지 못했습니다.'),el('p','',error.message));throw error;}
}
function dialog(title) {$('detail-title').textContent=title; $('detail-body').replaceChildren();if(!$('detail-dialog').open)$('detail-dialog').showModal();return $('detail-body');}
function sourceLinks(parent, filing) {
  const receipt=filing.rcept_no;if(!/^\d{14}$/.test(receipt))return;
  const a=el('a','','DART 원문 ↗');a.href=`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`;a.target='_blank';a.rel='noopener noreferrer';
  const b=el('a','','원문 ZIP 내려받기');b.href=`/api/originals/${receipt}`;b.download=`${receipt}.zip`;parent.append(a,b);
  if(window.dartCloudOriginal)b.addEventListener('click',e=>{e.preventDefault();window.dartCloudOriginal(receipt).catch(e=>notify(e.message));});
}
function evidenceBlock(parent, evidence) {
  const block=el('article','evidence');
  block.append(el('small','muted',`${evidence.filing.report_nm} · ${evidence.filing.rcept_dt}`),el('h3','',evidence.section||'원문'),
    el('small','muted',`${evidence.file} · 블록 ${evidence.block}`),el('pre','',evidence.text));
  if(evidence.context)block.prepend(el('span','tag',evidence.context+' · 자동 분류/확인 필요'));
  sourceLinks(block,evidence.filing);parent.append(block);
}
function showEvidence(company) {
  const body=dialog(company.name+' · 원문 근거');
  if(company.catalogEvidence){
    const c=company.catalogEvidence,box=el('article','evidence');
    box.append(el('h3','',c.source),el('p','',`업종: ${c.industry}`),el('pre','',c.products),el('p','scope-note','목록에 기재된 주요제품 기준의 후보입니다. 회사 선택 후 실제 공시 원문을 수집·검증합니다.'));
    const link=el('a','','KRX 상장법인 목록 ↗');link.href=c.url;link.target='_blank';link.rel='noopener noreferrer';box.append(link);body.append(box);
  }
  body.append(el('p','scope-note',`총 ${company.evidenceCount}개 중 최대 12개 근거를 표시합니다. 키워드 언급만으로 실제 제품 보유를 확정하지 않습니다.`));
  company.evidence.forEach(e=>evidenceBlock(body,e));
}
async function showCompanyRaw(code,name) {
  const body=dialog(name+' · 수집한 재무표 원문');body.append(el('p','muted','조회 중…'));
  const data=await api('/api/company?'+new URLSearchParams({code}));body.replaceChildren();
  if(!data.reports.length) {body.append(el('p','',"수집한 원문이 없습니다. ‘원문 수집’에서 선택한 회사의 보고서를 수집하세요."));return;}
  for(const r of data.reports) {
    const details=el('details','evidence');details.append(el('summary','',`${r.filing.report_nm} · ${r.filing.rcept_dt} · 재무 블록 ${r.totalBlocks}개`));
    sourceLinks(details,r.filing);
    r.blocks.forEach(b=>evidenceBlock(details,{...b,filing:r.filing}));body.append(details);
  }
}
async function startJob(kind,options) {
  notify('');const job=await api('/api/'+kind,options);
  if(kind==='analyze')state.analysisJob={id:job.id,revision:state.financialRevision};
  await refreshJobs();$('jobs-panel').scrollIntoView({behavior:'smooth',block:'nearest'});return job;
}
async function refreshJobs(restore=false) {
  const revision=++state.jobsRevision,financialRevision=state.financialRevision;
  const {jobs}=await api('/api/jobs'); const previous=state.jobs;
  if(revision!==state.jobsRevision)return;
  state.jobs=jobs;state.busy=jobs.filter(j=>['queued','running'].includes(j.state)).length>=MAX_ACTIVE_JOBS;renderJobs();
  const pending=state.analysisJob;
  const newlyFinished=jobs.filter(j=>j.state==='completed' && (restore || previous.some(old=>old.id===j.id && old.state!=='completed') || pending?.id===j.id));
  const latestFinancial=newlyFinished.find(j=>j.reportId && (!pending || pending.id===j.id));
  if(latestFinancial)await loadReport(latestFinancial.reportId,{automatic:true,revision:pending?.id===latestFinancial.id?pending.revision:financialRevision,allowBasisFallback:latestFinancial.basisFallback});
  if(latestFinancial?.kind==='analysis' && !restore && state.reportId===latestFinancial.reportId){
    page('financial');
    if(latestFinancial.hasData===false){notify('구조화 재무자료가 없어 수집한 감사보고서의 재무 원문을 표시합니다.');await showCompanyRaw(state.company.code,state.company.name);}
  }
  if(newlyFinished.length)await search(state.searchPage);
  const terminal=pending&&jobs.find(j=>j.id===pending.id&&!['queued','running'].includes(j.state));
  if(terminal){
    if(terminal.state!=='completed' && pending.revision===state.financialRevision){
      $('financial-content').className='panel empty';
      $('financial-content').replaceChildren(el('h2','',terminal.state==='error'?'분석에 실패했습니다.':'분석이 중지되었습니다.'),el('p','',terminal.message));
    }
    if(state.analysisJob?.id===pending.id)state.analysisJob=null;
  }
  $('fetch-financial').disabled=state.busy;
}
function jobProgress(job) {
  // Overall % from the counts the worker reports: collection 0-50%, financial 50-100% for analysis jobs.
  const ratio=(a,b)=>b>0?Math.min(1,Math.max(0,a/b)):null;
  const collected=job.selected===undefined?null:job.selected===0?1:ratio((job.processed||0)+(job.failures?.length||0),job.selected);
  const financial=job.steps?ratio(job.step||0,job.steps):null;
  let percent,stage=0;
  if(job.kind==='analysis'){
    stage=job.stage==='financial'?2:job.selected!==undefined?1:0;
    percent=stage===2?50+50*(financial??0):stage===1?5+45*(collected??0):2;
  }else if(job.kind==='scan')percent=collected===null?2:100*collected;
  else percent=financial===null?2:100*financial;
  if(job.state==='completed'){percent=100;stage=3;}
  return {percent:Math.round(percent),stage};
}
function sinceText(value) {
  const seconds=Math.round((Date.now()-Date.parse(value))/1000);
  if(!Number.isFinite(seconds))return '';
  return seconds<5?'방금 갱신':seconds<60?`${seconds}초 전 갱신`:`${Math.round(seconds/60)}분 전 갱신`;
}
function renderJobs() {
  const root=$('jobs');root.replaceChildren();
  if(!state.jobs.length){root.append(el('p','muted','아직 실행한 작업이 없습니다.'));return;}
  for(const job of state.jobs) {
    const row=el('article','job '+job.state),head=el('div','job-header'),content=el('div');
    const active=['queued','running'].includes(job.state);
    content.append(el('span','tag',({completed:'완료',error:'오류',cancelled:'중지',interrupted:'중단',running:'진행 중',queued:'대기'})[job.state]),el('span','job-message',job.message));
    head.append(content);
    if(active)head.append(button('중지',()=>api(`/api/jobs/${job.id}/stop`,{}).then(()=>refreshJobs()).catch(e=>notify(e.message))));
    else if(job.reportId)head.append(button('재무표 열기',()=>loadReport(job.reportId).then(()=>page('financial')).catch(e=>notify(e.message))));
    row.append(head);
    if(active){
      const {percent,stage}=jobProgress(job);
      const meter=el('div','job-meter'),progress=el('div','job-progress'),bar=el('i');
      bar.style.width=percent+'%';progress.append(bar);
      progress.setAttribute('role','progressbar');progress.setAttribute('aria-valuemin','0');progress.setAttribute('aria-valuemax','100');progress.setAttribute('aria-valuenow',String(percent));
      meter.append(progress,el('strong','job-percent',percent+'%'));row.append(meter);
      if(job.kind==='analysis'){
        const steps=el('ol','job-steps');
        const counts=[ '', job.selected!==undefined?` ${(job.processed||0)+(job.failures?.length||0)}/${job.selected}`:'', job.steps?` ${job.step||0}/${job.steps}`:''];
        ['회사 확인','공시 원문 수집','재무·제품 분석'].forEach((label,i)=>steps.append(el('li',i<stage?'done':i===stage?'current':'',(i<stage?'✓ ':`${i+1}. `)+label+(i===stage?counts[i]:''))));
        row.append(steps);
      }
      const since=sinceText(job.updated);if(since)row.append(el('small','job-since',since));
    }
    if(job.selected!==undefined)row.append(el('small','',`선택 ${job.selected}건 · 분석 ${job.processed||0}건 · 실패 ${job.failures?.length||0}건`));
    if(job.truncated)row.append(el('p','scope-note','보고서 상한에 도달했습니다. 전체 회사를 조사한 결과가 아닙니다. 기간을 나누어 추가 수집하세요.'));
    if(job.failures?.length){const d=el('details');d.append(el('summary','',`실패한 보고서 ${job.failures.length}건 보기`));job.failures.forEach(f=>d.append(el('p','',`${f.company} · ${f.receipt}\n${f.error}`)));row.append(d);}
    root.append(row);
  }
}
async function loadReport(id,options={}) {
  const revision=options.automatic?options.revision:++state.financialRevision;
  const report=await api('/api/reports/'+id);
  if(revision!==state.financialRevision)return;
  const basisMatches=$('basis').value===report.basis || (options.allowBasisFallback && $('basis').value==='CFS' && report.basis==='OFS');
  if(options.automatic && state.company && (state.company.code!==report.corp_code || !basisMatches || Number($('last-year').value)!==report.lastYear))return;
  state.report=report;state.reportId=id;state.company={name:report.company,code:report.corp_code};
  $('selected-company').value=`${report.company} (${report.corp_code})`;
  $('financial-title').textContent=report.company+' · 재무 분석';
  $('basis').value=report.basis;$('last-year').value=report.lastYear;
  $('scan-company').textContent=`선택한 회사: ${report.company} · ${report.corp_code}`;
  renderFinancial(report,id);
}
function number(value,isPercent=false) {
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';
  return new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(isPercent?Number(value):Number(value)/100000000)+(isPercent?'%':'');
}
function renderFinancial(report,id) {
  const root=$('financial-content');root.className='panel';root.replaceChildren();
  const bar=el('div','report-bar'),heading=el('div');
  heading.append(el('h2','',`${report.company} · ${report.lastYear-4}–${report.lastYear}`),el('small','muted',`${report.basis==='CFS'?'연결':'별도'} · 조회 ${new Date(report.asOf).toLocaleString('ko-KR')}`));
  const actions=el('div','card-actions');
  actions.append(button('Excel .xlsx ↓',()=>downloadReport(id,'xlsx').catch(e=>notify(e.message))));
  actions.append(button('수식 CSV 묶음 ↓',()=>downloadReport(id,'csv').catch(e=>notify(e.message))));
  actions.append(button('원문 재무표',()=>showCompanyRaw(report.corp_code,report.company).catch(e=>notify(e.message))));
  actions.append(button('☆ 관심·메모',()=>editResearch(report.corp_code,report.company).catch(e=>notify(e.message))));
  bar.append(heading,actions);root.append(bar,el('p','unit-label','금액: 억원 · 비율: % · 숫자를 누르면 원자료와 계산 근거를 확인할 수 있습니다.'));
  if(report.quality){
    const q=report.quality,box=el('details','quality-box');box.open=q.needsReview;
    box.append(el('summary','',`자료 확보: 연간 ${q.annualAvailable}/5년 · 제품 매출 ${q.productsPeriods}/5년 · 내수수출 ${q.marketsPeriods}/5년${q.outdated?' · 이전 버전/재분석 필요':''}`));
    box.append(el('p','scope-note',`주요 재무 항목 ${q.coreAvailable}/${q.coreExpected}개 확보. 미입수·미인식은 미공시 또는 0원이라는 뜻이 아닙니다.`));
    for(const p of q.periods){
      const missing=p.missing.map(k=>metrics[k]||k);
      box.append(el('p','quality-line',`${p.label}: ${p.available?'재무자료 있음':'재무자료 없음'}${missing.length?' · 미입수 '+missing.join(', '):''}${!p.products?' · 제품 매출 미인식':''}${!p.markets?' · 내수수출 미인식':''}`));
      [...p.checks,...p.warnings].forEach(w=>box.append(el('p','quality-warning',`${p.label}: ${w}`)));
    }root.append(box);
  }
  const table=el('table'),thead=el('thead'),head=el('tr');head.append(el('th','','과목'));report.columns.forEach(c=>head.append(el('th','',c.label)));thead.append(head);table.append(thead);
  const body=el('tbody');
  for(const [metric,label] of Object.entries(metrics)) {
    const row=el('tr',major.has(metric)?'major':'');row.append(el('th','',label));
    for(const col of report.columns){const cell=el('td');cell.append(button(number(col.values[metric],percent.has(metric)),()=>showCalculation(col,metric),'value-button'));row.append(cell);}
    body.append(row);
  }
  table.append(body);const wrap=el('div','table-container');wrap.append(table);root.append(wrap);
  for(const [kind,title] of [['products','제품·사업부문별 매출'],['markets','내수·수출 구성']]) {
    root.append(el('h3','section-heading',title),el('p','unit-label','공시된 항목 기준 · 금액: 억원 / 비중: % · 항목명을 누르면 출처를 확인할 수 있습니다.'));
    const names=[...new Set(report.columns.flatMap(c=>(c.supplement?.[kind]||[]).map(p=>p.name)))];
    if(!names.length){root.append(el('p','scope-note','자동 인식한 공시 표가 없습니다. 미공시·미인식 자료는 원문에서 확인하세요.'));continue;}
    const t=el('table'),h=el('thead'),r=el('tr');r.append(el('th','','항목'));report.columns.forEach(c=>r.append(el('th','',c.label)));h.append(r);t.append(h);
    const b=el('tbody');
    for(const name of names) {
      const row=el('tr');row.append(el('th','',name));
      for(const col of report.columns){
        const values=(col.supplement?.[kind]||[]).filter(p=>p.name===name),cell=el('td');
        if(values.length===1){const v=values[0];cell.append(button(`${number(v.amount)} / ${number(v.share,true)}`,()=>{const d=dialog(col.label+' · '+name);d.append(el('p','',`매출액 ${v.amount?.toLocaleString()}원 ÷ 분모 ${v.denominator?.toLocaleString()}원 × 100`),el('pre','raw-values',JSON.stringify(v,null,2)));sourceLinks(d,{rcept_no:v.receipt});},'value-button'));}
        else cell.textContent=values.length>1?'중복 표 · 원문 확인':'—';row.append(cell);
      }b.append(row);
    }
    t.append(b);const container=el('div','table-container');container.append(t);root.append(container);
  }
  const notes=el('div','report-notes');
  report.notes.forEach(n=>notes.append(el('p','',n)));
  report.columns.forEach(c=>(c.checks||[]).forEach(n=>notes.append(el('p','',`${c.label} · 검증: ${n}`))));root.append(notes);
}
function showCalculation(col,metric) {
  const body=dialog(`${col.label} · ${metrics[metric]}`);
  body.append(el('h3','',number(col.values[metric],percent.has(metric))));
  if(formula[metric])body.append(el('p','scope-note','계산식: '+formula[metric]));
  const source=col.sources?.[metric];
  if(source){body.append(el('pre','raw-values',`계정: ${source.account_nm}\n계정 ID: ${source.account_id}\nAPI 필드: ${source.field}\n원자료: ${source.value} ${source.currency}`));sourceLinks(body,{rcept_no:source.receipt});}
  else {body.append(el('pre','raw-values',JSON.stringify({values:col.values,depreciationSource:col.supplement?.depreciationSource||null},null,2)));if(col.receipt)sourceLinks(body,{rcept_no:col.receipt});}
  body.append(el('p','scope-note','누락값은 0이 아닙니다. XLSX 또는 CSV 내보내기에는 원자료와 실제 계산 수식이 포함됩니다.'));
}
async function downloadReport(id,format) {
  if(window.dartCloudDownload){notify('수식과 원자료가 포함된 파일을 만드는 중입니다…');await window.dartCloudDownload(state.report,format);notify('다운로드를 시작했습니다.');return;}
  const company=state.report?.company||'financials';
  notify('수식과 원자료를 포함한 파일을 만드는 중입니다…');
  const response=await fetch(`/api/reports/${id}/export?format=${format}`,{credentials:'same-origin'});
  if(!response.ok){const error=await response.json();throw new Error(error.error||'내보내기 실패');}
  const blob=await response.blob(),url=URL.createObjectURL(blob),a=el('a');a.href=url;
  a.download=`DART-${company}-${format==='xlsx'?'formulas.xlsx':'formulas.zip'}`;
  document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);notify('다운로드를 시작했습니다. 원자료와 실제 수식이 포함되어 있습니다.');
}
function pagination(id,current,total,choose) {
  const root=$(id),prev=button('← 이전',()=>choose(current-1)),next=button('다음 →',()=>choose(current+1));
  prev.disabled=current<=1;next.disabled=current>=total;
  root.replaceChildren(prev,el('span','muted',`${current} / ${total}`),next);
}
async function loadLibrary(requestedPage=1) {
  const revision=++state.libraryRevision;
  const params=new URLSearchParams({q:$('library-query').value.trim(),page:requestedPage,favorites:$('favorites-only').checked?'1':'0'});
  const data=await api('/api/library?'+params);if(revision!==state.libraryRevision)return;state.libraryPage=data.page;
  pagination('library-pagination',data.page,data.pages,p=>loadLibrary(p).catch(e=>notify(e.message)));
  const root=$('library-results');root.replaceChildren();
  if(!data.items.length){root.append(el('div','empty','해당 분석 결과나 관심회사가 없습니다. 검색 결과에서 관심·메모를 저장하거나 회사를 분석하세요.'));return;}
  for(const item of data.items){
    const card=companyCard(item.name,item.code),research=item.research||{};
    card.append(el('p','scope-note',item.id?`${item.year}년까지 · ${item.basis==='CFS'?'연결':'별도'} · ${item.asOf?new Date(item.asOf).toLocaleString('ko-KR'):''}`:'관심회사 · 아직 분석하지 않음'));
    if(item.quality)card.append(el('p','',`연간 ${item.quality.annualAvailable}/5년${item.quality.outdated?' · 이전 버전/재분석 필요':''}`));
    if(research.status && research.status!=='unreviewed')card.append(el('span','tag','사용자 검토: '+({confirmed:'제조·판매 확인',mention:'언급만 확인',exclude:'조사 대상 제외'})[research.status]));
    if(research.note)card.append(el('p','excerpt',research.note.slice(0,180)));
    if(item.id){const label=el('label','inline-check'),check=el('input');check.type='checkbox';check.checked=state.comparison.has(item.id);check.setAttribute('aria-label',`${item.name} ${item.year} ${item.basis} 비교 선택`);
      check.addEventListener('change',()=>{if(check.checked&&state.comparison.size>=4){check.checked=false;notify('최대 4개 결과를 비교할 수 있습니다.');return;}if(check.checked)state.comparison.set(item.id,item.name);else state.comparison.delete(item.id);$('compare-selected').textContent=`선택 기업 비교 (${state.comparison.size}/4)`;});
      label.append(check,document.createTextNode(' 비교 선택'));card.append(label);}
    const actions=el('div','card-actions');
    if(item.id)actions.append(button('저장된 결과 열기',()=>loadReport(item.id).then(()=>page('financial')).catch(e=>notify(e.message)),'primary'));
    actions.append(button('다시 분석',()=>{if(item.year)$('last-year').value=item.year;if(item.basis)$('basis').value=item.basis;analyzeCompany({code:item.code,name:item.name}).catch(e=>notify(e.message));}));
    actions.append(button(research.favorite?'★ 관심·메모':'☆ 관심·메모',()=>editResearch(item.code,item.name).catch(e=>notify(e.message))));
    card.append(actions);root.append(card);
  }
}
async function editResearch(code,name) {
  const value=await api('/api/research/'+code),body=dialog(name+' · 관심회사와 조사 메모');
  const label=el('label','inline-check'),favorite=el('input');favorite.type='checkbox';favorite.checked=!!value.favorite;favorite.id='research-favorite';label.append(favorite,document.createTextNode(' 관심회사로 저장'));body.append(label);
  const statusLabel=el('label','','사용자 검토 상태'),status=el('select');status.id='research-status';statusLabel.htmlFor=status.id;
  for(const [key,text] of Object.entries({unreviewed:'아직 확인하지 않음',confirmed:'원문으로 제조·판매 확인',mention:'타사·고객사 등 언급만 확인',exclude:'조사 대상에서 제외'})){const opt=el('option','',text);opt.value=key;status.append(opt);}status.value=value.status;
  const noteLabel=el('label','','조사 메모'),note=el('textarea');note.id='research-note';noteLabel.htmlFor=note.id;note.rows=7;note.maxLength=5000;note.value=value.note;
  body.append(statusLabel,status,el('p','scope-note','자동 분류는 참고용입니다. 제조·판매 확인 여부는 원문을 읽고 직접 선택하세요.'),noteLabel,note);
  body.append(button('저장',async()=>{try{await api('/api/research/'+code,{name,favorite:favorite.checked,status:status.value,note:note.value});$('detail-dialog').close();notify('관심회사와 메모를 저장했습니다.');if(!$('page-library').classList.contains('hidden'))await loadLibrary(state.libraryPage);}catch(e){notify(e.message);}},'primary'));
}
// ---- Multi-company financials -------------------------------------------------
function pickLabel(code){return state.picks.has(code)?'☑ 담음':'☐ 비교 담기';}
function pickButton(company){
  const b=button(pickLabel(company.code),()=>togglePick(company));
  b.dataset.pick=company.code;b.classList.toggle('picked',state.picks.has(company.code));return b;
}
function togglePick(company){
  if(state.picks.has(company.code))state.picks.delete(company.code);
  else if(state.picks.size>=MAX_PICKS){notify(`한 번에 최대 ${MAX_PICKS}곳까지 담을 수 있습니다.`);return;}
  else state.picks.set(company.code,company);
  renderPicks();
}
function renderPicks(){
  const n=state.picks.size;
  $('pick-tray').classList.toggle('hidden',!batchEnabled()||!n||!$('page-batch').classList.contains('hidden'));
  $('pick-count').textContent=`담은 회사 ${n}곳`;$('batch-count').textContent=n;
  document.querySelectorAll('[data-pick]').forEach(b=>{b.textContent=pickLabel(b.dataset.pick);b.classList.toggle('picked',state.picks.has(b.dataset.pick));});
  const list=$('batch-picks');list.replaceChildren();
  if(!n)list.append(el('p','muted','아직 담은 회사가 없습니다.'));
  for(const c of state.picks.values()){
    const chip=el('span','pick-chip',c.name);
    const remove=button('×',()=>togglePick(c),'pick-remove');remove.setAttribute('aria-label',c.name+' 빼기');
    chip.append(remove);list.append(chip);
  }
}
async function pickAllResults(){
  const params=p=>new URLSearchParams({q:$('query').value.trim(),category:state.category,page:p,sort:$('search-sort').value,size:MAX_PICKS});
  const trigger=$('pick-all'),label=trigger.textContent;trigger.disabled=true;trigger.textContent='담는 중…';
  let added=0,skipped=0;
  try{for(let p=1;;p++){
    const data=await api('/api/discover?'+params(p));
    for(const c of data.companies){
      if(state.picks.has(c.code))continue;
      if(state.picks.size>=MAX_PICKS){skipped++;continue;}
      state.picks.set(c.code,{name:c.name,code:c.code,stock:c.stock||''});added++;
    }
    if(p>=data.pages)break;
    if(state.picks.size>=MAX_PICKS){skipped+=Math.max(0,data.companyCount-p*data.companies.length);break;}
  }}finally{trigger.disabled=false;trigger.textContent=label;}
  renderPicks();
  notify(`${added}곳을 담았습니다.`+(skipped?` 최대 ${MAX_PICKS}곳까지만 담을 수 있어 ${skipped}곳은 제외했습니다.`:''));
}
async function runBatch(){
  if(!state.picks.size){notify('먼저 회사를 담아주세요.');return;}
  const revision=++state.batchRevision,options={companies:[...state.picks.values()],year:Number($('batch-year').value),basis:$('batch-basis').value,cashflow:$('batch-cashflow').checked};
  const started=performance.now();$('batch-run').disabled=true;$('batch-run').textContent='조회 중…';notify('');
  $('batch-status').textContent=`${options.companies.length}곳의 핵심 재무를 조회하고 있습니다…`;
  if(!state.batch){const root=$('batch-content');root.className='panel empty';root.replaceChildren(el('h2','','조회 중입니다…'),el('p','',`${options.companies.length}곳의 5개년 재무를 불러오고 있습니다.`));}
  try{
    const data=await window.dartCloudBatch(options,progress=>{
      if(revision!==state.batchRevision)return;
      if(progress.partial){state.batch={data:progress.partial,options};renderBatch();}
      if(progress.stage==='cashflow')$('batch-status').textContent=`핵심 재무 표시 완료 · 영업현금흐름 ${progress.done}/${progress.total}곳 조회 중…`;
    });
    if(revision!==state.batchRevision)return;
    state.batch={data,options};renderBatch();
    const missing=data.companies.filter(c=>!c.found).length;
    if(!data.asOf){$('batch-status').textContent='담은 회사 모두 미리 수집한 재무가 없습니다(비상장사 등 DART 구조화 재무 미제공). 회사 찾기에서 ‘선택하고 자동 분석’으로 감사보고서 원문을 분석하세요.';return;}
    $('batch-status').textContent=`${data.companies.length}곳 조회 완료 · ${((performance.now()-started)/1000).toFixed(1)}초 · DART 데이터 수집일 ${new Date(data.asOf).toLocaleDateString('ko-KR')}`+(missing?` · 자료 없음 ${missing}곳(비상장사 등)`:'');
  }catch(error){
    if(revision===state.batchRevision){
      $('batch-status').textContent='';
      if(!state.batch||state.batch.options!==options){const root=$('batch-content');root.className='panel empty';root.replaceChildren(el('h2','','조회하지 못했습니다.'),el('p','',error.message));}
    }
    throw error;
  }finally{if(revision===state.batchRevision){$('batch-run').disabled=false;$('batch-run').textContent='5개년 재무 한 번에 조회';}}
}
function renderBatch(){
  const {data,options}=state.batch,root=$('batch-content');root.className='panel';root.replaceChildren();
  state.batchYear=data.years.includes(state.batchYear)?state.batchYear:data.year;
  const bar=el('div','report-bar'),heading=el('div');
  heading.append(el('h2','',`${data.companies.length}곳 · ${data.years[0]}–${data.year} · ${data.basis==='CFS'?'연결':'별도'}`),el('small','muted','표는 선택한 연도, 엑셀에는 5개년 전체가 들어갑니다.'));
  const actions=el('div','card-actions'),select=el('select');select.setAttribute('aria-label','표시 연도');
  data.years.slice().reverse().forEach(y=>{const o=el('option','',`${y}년`);o.value=y;o.selected=y===state.batchYear;select.append(o);});
  select.addEventListener('change',()=>{state.batchYear=Number(select.value);renderBatch();});
  actions.append(select,button('Excel .xlsx ↓',()=>window.dartCloudBatchExcel(data,options),'primary'));
  bar.append(heading,actions);root.append(bar,el('p','unit-label','금액: 억원 · 비율: % · 빈 칸(—)은 미공시 값이며 0이 아닙니다.'));
  const cols=[['revenue','매출액'],['operatingIncome','영업이익'],['operatingMargin','영업이익률',1],['netIncome','당기순이익'],
    ...(options.cashflow?[['operatingCashFlow','영업현금흐름']]:[]),['assets','자산총계'],['liabilities','부채총계'],['equity','자본총계'],['debtRatio','부채비율',1],['revenueGrowth','매출성장률',1]];
  const fmt=(v,pct)=>v===null||v===undefined?'—':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v)+(pct?'%':'');
  const table=el('table'),thead=el('thead'),head=el('tr');
  head.append(el('th','','회사'),el('th','','기준'),...cols.map(([,label])=>el('th','',label)));thead.append(head);table.append(thead);
  const body=el('tbody');
  for(const c of data.companies){
    const r=c.rows.find(x=>x.year===state.batchYear)||{},row=el('tr',c.found?'':'missing');
    row.append(el('th','',c.name),el('td','',c.basisLabel),...cols.map(([k,,pct])=>el('td','',fmt(r[k],pct))));body.append(row);
  }
  table.append(body);const wrap=el('div','table-container');wrap.append(table);root.append(wrap);
}
async function compareSelected() {
  const data=await api('/api/compare?'+new URLSearchParams({ids:[...state.comparison.keys()].join(',')}));
  const body=dialog(`${data.year}년 · ${data.basis==='CFS'?'연결':'별도'} 기업 비교`),table=el('table'),thead=el('thead'),head=el('tr');head.append(el('th','','과목'));
  data.companies.forEach(c=>head.append(el('th','',c.company)));thead.append(head);table.append(thead);const rows=el('tbody');
  for(const [key,label] of Object.entries(metrics)){const row=el('tr',major.has(key)?'major':'');row.append(el('th','',label));data.companies.forEach(c=>row.append(el('td','',number(c.values[key],percent.has(key)))));rows.append(row);}table.append(rows);
  const wrap=el('div','table-container');wrap.append(table);body.append(el('p','scope-note','동일 사업연도·연결/별도의 연간 값만 비교합니다. 금액은 억원, 비율은 %입니다. 누락값은 0이 아닙니다. 결산월과 회계정책 차이는 각 공시에서 확인하세요.'),wrap);
}
document.querySelectorAll('[data-page]').forEach(n=>n.addEventListener('click',()=>page(n.dataset.page)));
document.addEventListener('click',e=>{const target=e.target.closest('[data-go]');if(target)page(target.dataset.go);});
$('login-form').addEventListener('submit',async e=>{e.preventDefault();$('login-error').textContent='';try{const result=await api('/api/login',{password:$('password').value});$('password').value='';if(result.loginPending){$('login-error').textContent='이메일로 로그인 링크를 보냈습니다. 메일의 링크를 열어주세요.';return;}await initialize();}catch(error){$('login-error').textContent=error.message;}});
$('logout').addEventListener('click',()=>api('/api/logout',{}).then(()=>{showLogin();state.jobs=[];state.report=null;state.reportId=null;}).catch(e=>notify(e.message)));
$('search-form').addEventListener('submit',e=>{e.preventDefault();search().catch(error=>notify(error.message));});
$('search-sort').addEventListener('change',()=>search().catch(e=>notify(e.message)));
$('library-form').addEventListener('submit',e=>{e.preventDefault();loadLibrary().catch(error=>notify(error.message));});
$('favorites-only').addEventListener('change',()=>loadLibrary().catch(e=>notify(e.message)));
$('compare-selected').addEventListener('click',()=>compareSelected().catch(e=>notify(e.message)));
$('clear-comparison').addEventListener('click',()=>{state.comparison.clear();$('compare-selected').textContent='선택 기업 비교 (0/4)';loadLibrary(state.libraryPage).catch(e=>notify(e.message));});
$('company-form').addEventListener('submit',e=>{e.preventDefault();lookupCompanies().catch(error=>{$('company-status').textContent=error.message;notify(error.message);});});
$('collect-form').addEventListener('submit',e=>{e.preventDefault();const selected=$('scan-scope').value==='selected';if(selected&&!state.company){notify('회사 찾기에서 먼저 회사를 선택하세요.');return;}
  startJob('scan',{start:$('start-date').value.replaceAll('-',''),end:$('end-date').value.replaceAll('-',''),limit:Number($('scan-limit').value),listed:$('listed').checked,unlisted:$('unlisted').checked,code:selected?state.company.code:''}).catch(error=>notify(error.message));});
$('financial-form').addEventListener('submit',e=>{e.preventDefault();if(!state.company){notify('회사 찾기에서 먼저 회사를 선택하세요.');return;}
  startJob('analyze',{code:state.company.code,basis:$('basis').value,year:Number($('last-year').value)}).catch(error=>notify(error.message));});
for(const id of ['basis','last-year'])$(id).addEventListener('change',()=>{state.financialRevision++;state.report=null;state.reportId=null;$('financial-content').className='panel empty';$('financial-content').replaceChildren(el('h2','','조회 조건이 변경되었습니다.'),el('p','','실제 재무 조회를 눌러 새 조건의 표를 불러오세요.'));});
$('pick-all').addEventListener('click',()=>pickAllResults().catch(e=>notify(e.message)));
for(const id of ['batch-clear','pick-tray-clear'])$(id).addEventListener('click',()=>{state.picks.clear();renderPicks();});
$('pick-tray-open').addEventListener('click',()=>page('batch'));
$('batch-form').addEventListener('submit',e=>{e.preventDefault();runBatch().catch(error=>notify(error.message));});
$('refresh-jobs').addEventListener('click',()=>refreshJobs().catch(e=>notify(e.message)));
$('close-dialog').addEventListener('click',()=>$('detail-dialog').close());
setInterval(()=>{if(!$('app').classList.contains('hidden'))refreshJobs().catch(e=>notify(e.message));},2500);
api('/api/session').then(s=>{$('logout').classList.toggle('hidden',!s.passwordRequired);return s.authenticated?initialize():showLogin();}).catch(e=>{showLogin();$('login-error').textContent=e.message;});
let cloudRefresh;
window.addEventListener('dart-cloud-change',()=>{clearTimeout(cloudRefresh);cloudRefresh=setTimeout(()=>{if(!$('app').classList.contains('hidden')){refreshJobs().catch(e=>notify(e.message));if(!$('page-library').classList.contains('hidden'))loadLibrary(state.libraryPage).catch(e=>notify(e.message));}},250);});
