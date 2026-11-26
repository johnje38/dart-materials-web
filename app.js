'use strict';
const $ = id => document.getElementById(id);
// Matches the cloud database limit; the local server still runs one job at a time and says so.
const MAX_ACTIVE_JOBS=3;
const state = {config:null, category:'', company:null, search:null, report:null, reportId:null, jobs:[], busy:false, searchRevision:0,financialRevision:0,jobsRevision:0,companyRevision:0,analysisJob:null};
const labels = {search:'소재·회사 검색', companies:'회사 찾기', financial:'회사 상세 · 재무 분석', batch:'다중분석', collect:'원문 수집',library:'분석 보관함'};
state.searchPage=1;state.libraryPage=1;state.libraryRevision=0;state.comparison=new Map();
// Companies picked for the multi-company financial view (cloud only).
state.picks=new Map();state.batch=null;state.batchRevision=0;
const MAX_PICKS=100;
const batchEnabled=()=>typeof window.dartCloudBatch==='function';
const metrics = {
  revenue:'매출액',cost:'매출원가',gross:'매출총이익',sga:'판매비와관리비',operating:'영업이익',margin:'영업이익률',
  depreciation:'유형자산 감가상각비',amortization:'무형자산 상각비',ebitda:'EBITDA',netIncome:'당기순이익',
  assets:'자산총계',cash:'현금및현금성자산',shortTermBorrowings:'단기차입금',currentLongTermBorrowings:'유동성장기차입금',longTermBorrowings:'장기차입금',shortTermInvestments:'단기금융상품',interestBearingDebt:'총차입금(사채·리스 포함)',netDebt:'순차입금(리스 포함)',netDebtRatio:'순차입금비율',liabilities:'부채총계',equity:'자본총계',liabilityRatio:'부채비율',
  liabilitiesLessCash:'부채총계−현금(참고)',liabilitiesLessCashRatio:'(부채−현금)/자본',operatingCash:'영업활동현금흐름',growth:'매출 증가율(전년 동기)'
};
const percent = new Set(['margin','liabilityRatio','liabilitiesLessCashRatio','growth','netDebtRatio']);
const major = new Set(['revenue','operating','margin','ebitda','netIncome','equity','netDebt']);
const formula = {margin:'영업이익 ÷ 매출액 × 100',liabilityRatio:'부채총계 ÷ 자본총계 × 100',
  netDebt:'총차입금(차입금·사채·리스부채) − 현금및현금성자산 − 단기금융상품',
  netDebtRatio:'순차입금 ÷ 자본총계 × 100',
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
  if(name==='companies')name='search';
  if(!labels[name])return;
  document.querySelectorAll('.page').forEach(n=>n.classList.toggle('hidden',n.id!==`page-${name}`));
  document.querySelectorAll('.nav').forEach(n=>n.classList.toggle('active',n.dataset.page===name));
  notify();// A message about the previous page does not belong on the next one.
  pinMenu();
  $('page-label').textContent=labels[name];
  if(name==='library')loadLibrary().catch(e=>notify(e.message));
  renderPicks();
  renderJobs();
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
  $('login-screen').classList.add('hidden'); $('app').classList.remove('hidden');pinMenu();
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
  const params=new URLSearchParams({q:$('query').value.trim(),category:state.category,page:requestedPage,sort:$('search-sort').value,favorites:$('search-favorites')?.checked?'1':'0'});
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
    card.append(button('솔브레인 검색 →',()=>{$('query').value='솔브레인';state.category='';renderCategories();search().catch(e=>notify(e.message));}));
    list.append(card);return;
  }
  for(const company of data.companies) {
    const card=companyCard(company.name,company.code,company.stock||'');
    card.classList.add('company-link-card');
    card.addEventListener('click',e=>{
      // On phones the excerpt is cut to three lines; the first tap on it shows the rest.
      const text=e.target.closest('.excerpt');
      if(text&&!text.classList.contains('open')&&text.scrollHeight>text.clientHeight+2){text.classList.add('open');return;}
      if(!e.target.closest('button,a,input,label,select,textarea')&&!window.getSelection()?.toString())analyzeCompany(company).catch(error=>notify(error.message));});
    if(batchEnabled())card.append(pickCheckbox(company));
    const tags=el('div','tag-row'); company.categories.forEach(c=>tags.append(el('span','tag',c))); card.append(tags);
    if(company.research?.status && company.research.status!=='unreviewed')tags.append(el('span','tag','사용자 검토: '+({confirmed:'제조판매 확인',mention:'언급만 확인',exclude:'제외로 표시'})[company.research.status]));
    // Some matches are only a heading or image caption ("(1) Sputtering Target"): prefer a real
    // paragraph, else show the short ones together.
    const first=company.evidence.find(e=>readable(e.text).length>=40),shorts=company.evidence.slice(0,4);
    const text=company.catalogEvidence?.products || first?.text || [...new Set(shorts.map(e=>readable(e.text)).filter(Boolean))].join(' · ') || '회사명·종목코드로 찾은 회사입니다. 사업·재무 보기에서 사업내용과 재무자료를 확인하세요.';
    const words=company.catalogEvidence?.matchedWords || first?.words || [...new Set(shorts.flatMap(e=>e.words||[]))];
    card.append(meta(company,company.catalogEvidence?null:first||shorts[0]));
    card.append(excerpt(text,words));
    const footer=el('div','card-footer');footer.append(el('span','',company.catalogEvidence?`KRX 주요제품 후보 · 저장 공시 ${company.reportCount}건`:company.directoryMatch?'DART 공식 회사명·종목코드 일치':`공시 근거 ${company.evidenceCount}개 · 보고서 ${company.reportCount}건`));
    if(company.catalogEvidence||company.evidence.length)footer.append(button('근거 보기 ↗',()=>showEvidence(company),'text-button'));card.append(footer);
    const actions=el('div','card-actions');
    actions.append(button('사업·재무 보기 →',()=>analyzeCompany(company).catch(e=>notify(e.message)),'primary'));
    actions.append(button('재무표 원문',()=>showCompanyRaw(company.code,company.name).catch(e=>notify(e.message))));
    const favorite=button(company.research?.favorite?'★ 즐겨찾기':'☆ 즐겨찾기',()=>{favorite.disabled=true;toggleFavorite(company).catch(e=>notify(e.message)).finally(()=>{favorite.disabled=false;});});
    favorite.setAttribute('aria-pressed',String(!!company.research?.favorite));
    actions.append(favorite,button('조사 메모',()=>editResearch(company.code,company.name).catch(e=>notify(e.message))));
    card.append(actions);list.append(card);
  }
  renderPicks();
}
// Which company this is (KRX industry) and where the excerpt comes from, so an equipment maker
// or a patent-list mention reads differently from a material maker's product line.
function meta(company,evidence) {
  const where=!evidence?(company.catalogEvidence?'KRX 주요제품':'DART 공식 회사 목록'):evidence.core===true?'사업보고서 '+(evidence.section||'사업의 내용').replace(/^\d+\.\s*/,''):
    evidence.core===false?'사업보고서 연구개발·기타 참고사항':'저장한 공시 원문';
  const node=el('p','card-meta');
  if(company.industry){
    const equipment=/기계 제조업|정밀기기|건설업|엔지니어링|도매업|운송장비/.test(company.industry);
    node.append(el('span',equipment?'industry equipment':'industry','업종: '+company.industry+(equipment?' (장비·설비 업종)':'')),' · ');
  }
  node.append('근거: '+where);
  return node;
}
// Search terms match with spaces ignored ("Photo Resist" = photoresist), so find them the same way.
function termPattern(terms) {
  const parts=terms.filter(Boolean).map(t=>[...String(t).replace(/\s+/g,'')].map(c=>c.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('\\s*'));
  return parts.length?new RegExp(parts.sort((a,b)=>b.length-a.length).join('|'),'gi'):null;
}
// Annual-report text arrives with tables flattened to "cell | cell" and paragraphs glued
// ("있습니다.Slurry"): keep only the wording cells and put the spaces back.
function readable(text) {
  text=String(text||'');
  if(text.includes('|'))text=text.split(/\s*\|\s*|\n+/).map(c=>c.trim()).filter(c=>c&&!/^[-−△()\d.,%\s]*$/.test(c)).join(' · ');
  // Stored filings ran cell lines together ("CMP PADWet Chemical"); split a capitals run from a following word.
  return text.replace(/([A-Z]{2,})(?=[A-Z][a-z]{2,})/g,'$1 ').replace(/[^\s\]\[|]+\.(?:jpe?g|png|gif|bmp)\b/gi,'').replace(/([가-힣][.!?])(?=[A-Za-z가-힣(])/g,'$1 ').replace(/\s+/g,' ').trim();
}
// The sentence (or table cell) holding the first match, with the match in bold. Starts and ends at
// sentence boundaries when one is near, so the card reads as whole sentences; "…" marks a real cut.
// A fresh regex each use: a shared /g regex carries lastIndex from one card into the next.
const boundaries=()=>/[.!?](?=\s)|\s·(?=\s)/g;
function excerpt(raw,terms) {
  const text=readable(raw),pattern=termPattern(terms),node=el('p','excerpt');
  const hit=pattern?pattern.exec(text):null,position=hit?hit.index:0,matchEnd=hit?position+hit[0].length:0;
  // Start: the last boundary within 120 characters before the match, else a word ~60 before it.
  let start=0,cut=false;
  if(position>120||[...text.slice(0,position).matchAll(boundaries())].length){
    const from=Math.max(0,position-120),lead=[...text.slice(from,position).matchAll(boundaries())].pop();
    if(lead)start=from+lead.index+lead[0].length+1;
    else if(from>0){start=Math.max(0,position-60);const space=text.indexOf(' ',start);if(space>=0&&space<position)start=space+1;cut=true;}
  }
  // End: the first boundary after 120 characters (and after the match), within 260; else a word near 200.
  let end=text.length,endCut=false;
  if(end-start>260){
    const after=boundaries();after.lastIndex=Math.max(start+120,matchEnd);const tail=after.exec(text);
    if(tail&&tail.index<start+260)end=tail.index+tail[0].length;
    else{end=Math.max(text.lastIndexOf(' ',start+200),matchEnd);endCut=true;}
  }
  const shown=text.slice(start,end).replace(/\s·$/,'');
  if(cut)node.append('…');
  let last=0;
  if(pattern){pattern.lastIndex=0;for(const m of shown.matchAll(pattern)){node.append(shown.slice(last,m.index),el('mark','',m[0]));last=m.index+m[0].length;}}
  node.append(shown.slice(last));
  if(endCut)node.append('…');
  return node;
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
  loadCompanyBusiness(company,state.financialRevision);
}
// Reports are stored paragraph by paragraph; show each section once with its paragraphs joined.
function businessSections(blocks){
  const sections=new Map();
  for(const b of blocks||[]){if(!b.core)continue;const name=b.section||'주요 사업·제품';
    if(sections.has(name))sections.get(name).push(b.text);else sections.set(name,[b.text]);}
  return [...sections].map(([section,texts])=>({section,text:texts.join('\n\n')}));
}
async function loadCompanyBusiness(company,revision){
  const root=$('company-business');if(!root)return;
  root.classList.remove('hidden');root.replaceChildren(el('h2','',company.name+' · 주된 사업내용'));
  if(company.catalogEvidence?.products)root.append(el('p','',company.catalogEvidence.products));
  try{
    const data=await api('/api/company-profile?'+new URLSearchParams({code:company.code}));
    if(revision!==state.financialRevision)return;
    root.replaceChildren(el('h2','',company.name+' · 주된 사업내용'));
    if(data.listing){root.append(el('p','scope-note',`업종: ${data.listing.industry||'미확인'} · 종목코드 ${data.listing.stock||company.stock||'없음'}`),el('p','',data.listing.products||'주요제품 정보 없음'),el('p','scope-note','출처: KRX 주요제품 목록'));
    }
    if(data.shareholders)renderShareholderLine(root,data.shareholders);
    const blocks=businessSections(data.report?.blocks).slice(0,3);
    if(blocks.length){root.append(el('h3','section-heading','사업보고서의 사업·제품 설명'));
      for(const b of blocks){const d=el('details','evidence');d.append(el('summary','',b.section),el('pre','raw-values',b.text));root.append(d);}
      root.append(el('p','scope-note',data.report.report_name||'사업보고서'));
      if(/^\d{14}$/.test(data.report.receipt)){const a=el('a','text-button','DART 사업보고서 원문 ↗');a.href=`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${data.report.receipt}`;a.target='_blank';a.rel='noopener noreferrer';root.append(a);}
    }else root.append(el('p','scope-note','저장된 사업보고서의 주요 사업 설명이 없습니다. 미입수는 사업이 없다는 뜻이 아닙니다.'));
    if(data.warning)root.append(el('p','quality-warning',data.warning));
  }catch(error){if(revision===state.financialRevision)root.append(el('p','quality-warning','사업내용 추가 조회 실패: '+error.message));}
}
const pct=v=>v==null?'미기재':`${Number(v).toFixed(2)}%`;
function renderShareholderLine(root,h){
  const basis=`${h.report_name||'최근 정기보고서'}${h.settled?` · ${h.settled} 기준`:''}`;
  const line=el('p','shareholder-line');
  if(!h.largest_name){line.append(el('b','','최대주주 '),document.createTextNode(`정보 없음 (${basis})`));root.append(line);return;}
  line.append(el('b','','최대주주 '),document.createTextNode(`${h.largest_name} ${pct(h.largest_rate)} · 특수관계인 포함 ${pct(h.group_rate)} `));
  line.append(el('span','scope-note',`(${basis})`),document.createTextNode(' '));
  line.append(button('근거 보기',()=>showShareholders(h),'text-button'));
  root.append(line);
}
function showShareholders(h){
  const body=dialog(`${h.name} · 최대주주 현황`);
  body.append(el('p','',`최대주주: ${h.largest_name||'미기재'} (${h.largest_relation||'관계 미기재'}) · 보통주 ${pct(h.largest_rate)}`));
  body.append(el('p','',`특수관계인 포함 보통주 합계: ${pct(h.group_rate)}`));
  body.append(el('p','scope-note',h.group_source==='dart'?`합계는 DART 표의 "계" 행 값입니다. 각 행을 직접 더하면 ${pct(h.summed_rate)}입니다 (행마다 반올림해서 0.01%p 정도 차이 날 수 있습니다).`
    :h.group_source==='sum'?'DART 표의 "계" 행이 비어 있어 아래 보통주 지분율을 직접 더한 값입니다.':'합계를 계산할 수 없습니다.'));
  body.append(el('p','scope-note',`출처: ${h.report_name||'정기보고서'} · 결산기준일 ${h.settled||'미기재'} · 접수번호 ${h.receipt} · Open DART 최대주주 현황(hyslrSttus)`));
  sourceLinks(body,{rcept_no:h.receipt});
  const table=el('table','data-table'),head=el('tr');
  for(const t of ['성명','관계','주식 종류','기말 주식수','기말 지분율','비고'])head.append(el('th','',t));
  table.append(head);
  for(const r of h.rows||[]){const tr=el('tr');for(const v of [r.nm,r.relate,r.stock_knd,r.trmend_posesn_stock_co,r.trmend_posesn_stock_qota_rt,r.rm])tr.append(el('td','',v==null||v===''?'-':String(v).trim()));table.append(tr);}
  const box=el('div','table-container');box.append(table);body.append(box);
  body.append(el('p','scope-note','지분율은 보고서 결산기준일 현재입니다. 그 뒤의 지분 변동(대량보유·임원 소유 보고)은 반영되지 않습니다.'));
}
async function toggleFavorite(company){
  const previous=await api('/api/research/'+company.code);
  await api('/api/research/'+company.code,{name:company.name,favorite:!previous.favorite,status:previous.status||'unreviewed',note:previous.note||''});
  await search(state.searchPage);
}
async function analyzeCompany(company,{force=false}={}) {
  selectCompany(company);
  const revision=state.financialRevision;
  if(window.dartCloudApi&&!force){
    $('financial-content').replaceChildren(el('h2','',`${company.name} · 저장된 결과 확인 중`));
    const {cached}=await api('/api/prepared?'+new URLSearchParams({code:company.code,basis:$('basis').value,year:$('last-year').value}));
    if(revision!==state.financialRevision)return;
    if(cached){await loadReport(cached.id,{automatic:true,revision,allowBasisFallback:true,preloaded:cached.report});notify('저장된 분석 결과를 불러왔습니다. 자료 기준일을 확인하세요. 새로 분석하려면 공시 수집·재무 분석 버튼을 누르세요.');return;}
    $('financial-content').replaceChildren(el('h2','','아직 준비된 재무분석이 없습니다.'),el('p','','위에서 주요 사업내용을 확인할 수 있습니다. 재무자료가 필요하면 공시 수집·재무 분석 버튼을 눌러주세요. 사전 분석 결과는 순차적으로 준비됩니다.'));
    return;
  }
  if(state.busy){$('financial-content').replaceChildren(el('p','','저장된 결과가 없고 다른 분석이 진행 중입니다. 잠시 후 다시 시도하세요.'));notify(`분석은 동시에 ${MAX_ACTIVE_JOBS}개까지 실행할 수 있습니다. 하나가 끝나거나 중지한 뒤 다시 시도하세요.`);return;}
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
  if(!data.reports.length) {
    // Results-only analyses (listed companies outside the material search) keep no
    // filing text; each figure's receipt still opens the original on DART.
    const cols=state.report?.corp_code===code?state.report.columns||[]:[];
    const seen=new Map();for(const col of cols)for(const s of Object.values(col.sources||{}))if(/^\d{14}$/.test(s?.receipt||'')&&!seen.has(s.receipt))seen.set(s.receipt,col.label||String(col.year));
    if(!seen.size){body.append(el('p','',"수집한 원문이 없습니다. ‘원문 수집’에서 선택한 회사의 보고서를 수집하세요."));return;}
    body.append(el('p','scope-note','이 회사는 분석 결과만 저장하고 공시 원문은 보관하지 않습니다. 아래 링크로 DART에서 원문을 확인하세요.'));
    for(const [receipt,label] of seen){const p=el('p','',`${label} · 접수번호 ${receipt} `);const a=el('a','text-button','DART 원문 ↗');a.href=`https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${receipt}`;a.target='_blank';a.rel='noopener noreferrer';p.append(a);body.append(p);}
    return;
  }
  for(const r of data.reports) {
    const details=el('details','evidence');details.append(el('summary','',`${r.filing.report_nm} · ${r.filing.rcept_dt} · 재무 블록 ${r.totalBlocks}개`));
    sourceLinks(details,r.filing);
    r.blocks.forEach(b=>evidenceBlock(details,{...b,filing:r.filing}));body.append(details);
  }
}
async function startJob(kind,options) {
  notify('');const job=await api('/api/'+kind,options);
  if(kind==='analyze')state.analysisJob={id:job.id,revision:state.financialRevision};
  await refreshJobs();if(!$('jobs-panel').classList.contains('hidden'))$('jobs-panel').scrollIntoView({behavior:'smooth',block:'nearest'});return job;
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
  if(latestFinancial?.kind==='analysis' && !restore && state.reportId===latestFinancial.reportId && !$('page-financial').classList.contains('hidden')){
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
  const jobs=companyActiveJobs(state.jobs,state.company?.code,state.analysisJob,state.financialRevision);
  $('jobs-panel').classList.toggle('hidden',!jobs.length||$('page-financial').classList.contains('hidden'));
  for(const job of jobs) {
    const row=el('article','job '+job.state),head=el('div','job-header'),content=el('div');
    const active=['queued','running'].includes(job.state);
    content.append(el('span','tag',({completed:'완료',error:'오류',cancelled:'중지',interrupted:'중단',running:'진행 중',queued:'대기'})[job.state]),el('strong','',state.company?.name||'선택한 회사'),el('span','job-message',' · '+job.message));
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
    if(job.selected!==undefined)row.append(el('small','',`공시 원문 처리 ${job.processed||0}/${job.selected}건 · 수집·처리 실패 ${job.failures?.length||0}건`));
    if(job.truncated)row.append(el('p','scope-note','보고서 상한에 도달했습니다. 전체 회사를 조사한 결과가 아닙니다. 기간을 나누어 추가 수집하세요.'));
    if(job.failures?.length){const d=el('details');d.append(el('summary','',`실패한 보고서 ${job.failures.length}건 보기`));job.failures.forEach(f=>d.append(el('p','',`${f.company} · ${f.receipt}\n${f.error}`)));row.append(d);}
    root.append(row);
  }
}
function companyActiveJobs(jobs,code,pending,revision){
  if(!code)return [];
  return jobs.filter(j=>['queued','running'].includes(j.state)&&((j.params?.code||j.scope?.code||j.code)===code||pending?.id===j.id&&pending.revision===revision));
}
async function loadReport(id,options={}) {
  const revision=options.automatic?options.revision:++state.financialRevision;
  const report=options.preloaded||await api('/api/reports/'+id);
  if(revision!==state.financialRevision)return;
  const basisMatches=$('basis').value===report.basis || (options.allowBasisFallback && $('basis').value==='CFS' && report.basis==='OFS');
  if(options.automatic && state.company && (state.company.code!==report.corp_code || !basisMatches || Number($('last-year').value)!==report.lastYear))return;
  state.report=report;state.reportId=id;state.company={name:report.company,code:report.corp_code};
  if(!options.automatic)loadCompanyBusiness(state.company,revision);
  $('selected-company').value=`${report.company} (${report.corp_code})`;
  $('financial-title').textContent=report.company+' · 재무 분석';
  $('basis').value=report.basis;$('last-year').value=report.lastYear;
  $('scan-company').textContent=`선택한 회사: ${report.company} · ${report.corp_code}`;
  renderFinancial(report,id);
  renderJobs();
}
function number(value,isPercent=false) {
  if(value===null||value===undefined||!Number.isFinite(Number(value)))return '—';
  return new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(isPercent?Number(value):Number(value)/100000000)+(isPercent?'%':'');
}
function reportCoverage(report){
  const core=['revenue','operating','netIncome','assets','liabilities','equity'];
  const has=v=>v!=null&&Number.isFinite(Number(v));
  const years=Array.from({length:5},(_,i)=>Number(report.lastYear)-4+i);
  const periods=years.map(year=>{
    const col=(report.columns||[]).find(c=>c.year===year&&(c.report||'11011')==='11011');
    const missing=core.filter(k=>!has(col?.values?.[k]));
    return {year,available:missing.length<core.length,missing,netDebtMissing:!has(col?.values?.netDebt)};
  });
  const quarters=(report.columns||[]).filter(c=>(c.report||'11011')!=='11011'&&core.some(k=>has(c.values?.[k])))
    .sort((a,b)=>b.year-a.year||({'11013':1,'11012':2,'11014':3}[b.report]||0)-({'11013':1,'11012':2,'11014':3}[a.report]||0));
  return {periods,available:periods.filter(p=>p.available).map(p=>p.year),complete:periods.filter(p=>!p.missing.length).length,
    missingYears:periods.filter(p=>!p.available).map(p=>p.year),quarter:quarters[0]?.label||'입수한 분기자료 없음'};
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
  const coverage=reportCoverage(report),summary=el('div','coverage-summary');
  summary.append(el('p','',`연간 자료가 있는 연도: ${coverage.available.length?coverage.available.join(' · '):'없음'} (${coverage.available.length}/5년)`),
    el('p','',`주요 6개 항목 모두 확보: ${coverage.complete}/5년 · 최신 분기: ${coverage.quarter}`));
  if(coverage.missingYears.length)summary.append(el('p','quality-warning',`연간 자료 미입수: ${coverage.missingYears.join(' · ')}`));
  const missing=coverage.periods.filter(p=>p.missing.length||p.netDebtMissing);
  if(missing.length){const details=el('details');details.append(el('summary','','미입수 항목 확인'));
    for(const p of missing)details.append(el('p','scope-note',`${p.year}: ${[...p.missing.map(k=>metrics[k]||k),...(p.netDebtMissing?['순차입금 계산 자료']:[])].join(', ')}`));
    summary.append(details);
  }
  root.append(summary);
  if(report.prepared){const p=report.prepared;root.append(el('p','scope-note',`사전 분석 결과 · 공시 대조 ${p.checkedAt?new Date(p.checkedAt).toLocaleString('ko-KR'):'미확인'} · ${p.state==='retry'?'최근 갱신 실패로 이전 결과 표시':'최근 대조 시점까지 확인한 자료'}`));}
  root.append(el('p','scope-note','순차입금은 차입금·사채·리스부채에서 현금및현금성자산과 단기금융상품을 뺀 값입니다. 순차입금비율은 순차입금÷자본총계×100입니다. 음수는 순현금입니다. 구성 항목 미확인 시 —로 표시합니다. 이전 결과는 다시 분석해 주세요.'));
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
  if(col.source==='audit')body.append(el('p','scope-note',`감사보고서 보완 · ${col.auditPeriod==='prior'?'다음 연도 감사보고서의 전기 비교금액':'해당 연도 당기금액'} · 접수번호 ${col.auditReceipt||col.receipt||'미보관'}`));
  if(['netDebt','netDebtRatio','interestBearingDebt'].includes(metric)){
    const netMetric=metric!=='interestBearingDebt';
    const detail=col.netDebtDetail;
    body.append(el('p','scope-note',formula.netDebt+' · 순차입금비율 = '+formula.netDebtRatio));
    if(!detail)body.append(el('p','quality-warning','이전 분석에는 차입금 자료가 없습니다. 다시 분석해 주세요.'));
    else if(detail.reason)body.append(el('p','quality-warning',detail.reason));
    for(const n of detail?.notes||[])body.append(el('p','scope-note',n));
    if(netMetric&&col.values.cash==null)body.append(el('p','quality-warning','현금및현금성자산 미입수로 계산할 수 없습니다.'));
    if(netMetric&&col.values.shortTermInvestments==null)body.append(el('p','quality-warning','단기금융상품 미입수로 계산할 수 없습니다. 계정이 없다는 이유로 0을 넣지 않습니다.'));
    if(metric==='netDebtRatio'&&(col.values.equity==null||col.values.equity===0))body.append(el('p','quality-warning','자본총계 미입수 또는 0으로 비율을 계산할 수 없습니다.'));
    if(netMetric&&col.values.netDebt<0)body.append(el('p','','순현금 상태: 현금및현금성자산과 단기금융상품이 총차입금보다 많습니다.'));
    if(detail?.components?.length)body.append(el('h3','',`더한 항목 ${detail.components.length}개`));
    for(const component of detail?.components||[]){
      renderMetricSource(body,col,component.account_nm+(component.section?` (${component.section})`:''),component);
    }
    if(netMetric){
      for(const key of ['cash','shortTermInvestments',...(metric==='netDebtRatio'?['equity']:[])])if(col.sources?.[key])renderMetricSource(body,col,key,col.sources[key]);
    }
    return;
  }
  body.append(el('p','scope-note',`${col.year}년 · ${col.report==='11011'?'연간':col.label} · ${(col.basis||state.report?.basis)==='CFS'?'연결':'별도'} · ${col.source==='audit'?'감사보고서 재무표 인식':'DART 구조화 재무정보'}`));
  if(col.values[metric]==null){
    const reason=col.status==='013'?'해당 기간·기준의 구조화 재무자료 없음. 원문 감사보고서의 자료 유무는 별도 확인이 필요합니다.':formula[metric]?'계산에 필요한 입력값 누락 또는 분모가 0입니다.':col.source==='audit'?'원문에서 이 항목의 금액을 확인하지 못했습니다. 미공시 또는 표 인식 누락 여부를 원문과 대조하세요.':'응답에서 이 계정의 값을 찾지 못했습니다. 미공시 또는 계정 매칭 실패 여부는 원문 확인이 필요합니다.';
    body.append(el('p','quality-warning','누락 사유: '+reason));
    (col.warnings||[]).forEach(w=>body.append(el('p','quality-warning',w)));
  }
  if(col.acquisition?.document==='download_failed')body.append(el('p','quality-warning','공시 원문 수집 실패 · 주석 기반 항목은 원문을 다시 수집한 후 확인하세요.'));
  if(col.acquisition?.document==='analysis_failed')body.append(el('p','quality-warning','공시 원문 표 인식 실패 · 원문과 직접 대조하세요.'));
  if(formula[metric])body.append(el('p','scope-note','계산식: '+formula[metric]));
  const source=col.sources?.[metric];
  if(source)renderMetricSource(body,col,metric,source);
  else {
    const inputs={margin:['operating','revenue'],liabilityRatio:['liabilities','equity'],
      liabilitiesLessCash:['liabilities','cash'],liabilitiesLessCashRatio:['liabilities','cash','equity'],
      growth:['revenue','previousRevenue'],ebitda:['operating','depreciation','amortization']}[metric]||[metric];
    body.append(el('h3','','계산에 사용한 원자료'));
    for(const key of inputs){
      if(col.sources?.[key])renderMetricSource(body,col,key,col.sources[key]);
      else if(['depreciation','amortization'].includes(key)){
        const d=col.supplement?.depreciationSource,box=el('article','evidence');
        box.append(el('h3','',metrics[key]),el('p','',number(col.values[key])));
        if(d){box.append(el('p','scope-note',`${d.section||'현금흐름 주석'} · ${d.file||'파일 위치 미보관'} · 표 ${d.table||'위치 미보관'} · 단위 ${d.unit||'미보관'}`),el('p','',d.validation||'공시 주석에서 추출한 상각비'));
          sourceLinks(box,{rcept_no:d.receipt});
        }else box.append(el('p','quality-warning','이 항목의 상세 원문 위치를 저장하지 못했습니다. 원문 대조가 필요합니다.'));
        body.append(box);
      }else body.append(el('p','quality-warning',`${metrics[key]||key}: 원자료 출처 미입수`));
    }
  }
  body.append(el('p','scope-note','누락값은 0이 아닙니다. XLSX 또는 CSV 내보내기에는 원자료와 실제 계산 수식이 포함됩니다.'));
}
function renderMetricSource(parent,col,key,source){
  const companyCode=state.company?.code;
  const box=el('article','evidence');
  box.append(el('h3','',metrics[key]||(key==='previousRevenue'?'전년 동기 매출액':key)),
    el('p','',`${source.value??'미입수'} ${source.currency||'통화 미보관'}`),
    el('p','scope-note',`${source.year||(key==='previousRevenue'?col.year-1:col.year)}년 · ${(source.basis||col.basis||state.report?.basis)==='CFS'?'연결':'별도'} · ${source.statement||'재무제표 구분 미보관'} · ${source.field||'필드 미보관'}`),
    el('p','',`계정: ${source.account_nm||'미보관'} · 계정 ID: ${source.account_id||'사용자 정의/미보관'}`),
    el('p','scope-note',`공시 접수번호: ${source.receipt||'미보관'} · ${col.source==='audit'?'감사보고서 원문에서 추출한 값':'Open DART 구조화 응답의 계정값'}`));
  sourceLinks(box,{rcept_no:source.receipt});
  if(source.sourceRow){const details=el('details');details.append(el('summary','','저장된 계정 응답 확인'),el('pre','raw-values',JSON.stringify(source.sourceRow,null,2)));box.append(details);}
  if(source.receipt&&source.account_nm&&state.company){
    box.append(button('저장 원문에서 대조 후보 찾기',async()=>{
      const result=el('div');box.append(result);result.append(el('p','muted','저장된 공시를 확인하고 있습니다…'));
      try{
        const data=await api('/api/company?'+new URLSearchParams({code:companyCode}));
        const matches=findSourceCandidates(data,source);
        result.replaceChildren(el('p','quality-warning','아래 내용은 같은 접수번호·계정명으로 찾은 대조 후보입니다. 금액·단위·당기/전기·연결/별도를 원문에서 확인하세요.'));
        if(!matches.length)result.append(el('p','','저장된 원문 범위에서 해당 계정의 위치를 찾지 못했습니다. 위 DART 원문 링크에서 확인하세요.'));
        for(const b of matches)result.append(el('p','scope-note',`${b.section||'재무표'} · ${b.file||'파일 미보관'} · 블록 ${b.block??'미보관'}`),el('pre','raw-values',b.text));
      }catch(e){result.replaceChildren(el('p','quality-warning','원문 대조 후보 조회 실패: '+e.message));}
    },'outline'));
  }
  parent.append(box);
}
function findSourceCandidates(data,source){
  const normalize=s=>String(s||'').replace(/\s+/g,'');
  const name=normalize(source.account_nm);
  if(!name||!/^\d{14}$/.test(source.receipt||''))return [];
  return (data.reports||[]).filter(r=>r.filing?.rcept_no===source.receipt)
    .flatMap(r=>r.blocks||[]).filter(b=>normalize(b.text).includes(name)).slice(0,3);
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
  // A single page needs no paging buttons.
  root.classList.toggle('hidden',(total||1)<=1);
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
    actions.append(button('다시 분석',()=>{if(item.year)$('last-year').value=item.year;if(item.basis)$('basis').value=item.basis;analyzeCompany({code:item.code,name:item.name},{force:true}).catch(e=>notify(e.message));}));
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
function pickCheckbox(company){
  const label=el('label','inline-check company-select'),check=el('input');check.type='checkbox';
  check.dataset.pickCheck=company.code;check.checked=state.picks.has(company.code);
  check.setAttribute('aria-label',company.name+' 다중분석 선택');
  check.addEventListener('change',()=>{togglePick({name:company.name,code:company.code,stock:company.stock||''});check.checked=state.picks.has(company.code);});
  label.append(check,document.createTextNode('다중분석 선택'));return label;
}
function togglePick(company){
  if(state.picks.has(company.code))state.picks.delete(company.code);
  else if(state.picks.size>=MAX_PICKS){notify(`한 번에 최대 ${MAX_PICKS}곳까지 담을 수 있습니다.`);return;}
  else state.picks.set(company.code,company);
  renderPicks();
}
function renderPicks(){
  const n=state.picks.size;
  const signature=[...state.picks.keys()].sort().join(',');
  if(state.batchSelectionSignature!==undefined&&state.batchSelectionSignature!==signature){
    state.batchRevision++;state.batch=null;
    $('batch-run').disabled=false;$('batch-run').textContent='5개년 재무 한 번에 조회';
    $('batch-status').textContent='';const root=$('batch-content');root.className='panel empty';
    root.replaceChildren(el('h2','','선택한 회사가 변경되었습니다.'),el('p','','다중분석 버튼 또는 위 조회 버튼으로 새 선택의 재무표를 확인하세요.'));
  }
  state.batchSelectionSignature=signature;
  $('pick-tray').classList.toggle('hidden',!batchEnabled()||!n||!$('page-batch').classList.contains('hidden'));
  $('pick-count').textContent=`${n}개 회사 선택`;$('batch-count').textContent=n;
  $('selection-actions').classList.toggle('hidden',!batchEnabled()||!n);
  $('selection-count').textContent=`${n}개 회사 선택`;
  $('selection-analyze').disabled=!n;$('pick-tray-open').disabled=!n;
  document.querySelectorAll('[data-pick-check]').forEach(c=>{c.checked=state.picks.has(c.dataset.pickCheck);c.closest('.company-card')?.classList.toggle('selected',c.checked);});
  document.querySelectorAll('[data-pick]').forEach(b=>{b.textContent=pickLabel(b.dataset.pick);b.classList.toggle('picked',state.picks.has(b.dataset.pick));});
  const list=$('batch-picks');list.replaceChildren();
  if(!n)list.append(el('p','muted','아직 담은 회사가 없습니다.'));
  for(const c of state.picks.values()){
    const chip=el('span','pick-chip',c.name);
    const remove=button('×',()=>togglePick(c),'pick-remove');remove.setAttribute('aria-label',c.name+' 빼기');
    chip.append(remove);list.append(chip);
  }
  renderSidePicks(n);
}
// The sidebar's empty lower area lists the checked companies, one small line each.
function renderSidePicks(n){
  let box=$('side-picks');
  if(!box){
    box=el('div','side-picks hidden');box.id='side-picks';box.setAttribute('role','region');box.setAttribute('aria-label','다중분석 선택 회사');
    const head=el('div','side-picks-head');head.append(el('span','','다중분석 선택'),el('b','side-picks-count','0'));
    box.append(head,el('ol','side-picks-list'),button('다중분석 →',()=>openSelectedBatch().catch(e=>notify(e.message)),'side-picks-open'));
    document.querySelector('.sidebar-bottom').before(box);
  }
  box.classList.toggle('hidden',!batchEnabled()||!n);
  box.querySelector('.side-picks-count').textContent=n;
  const list=box.querySelector('.side-picks-list');list.replaceChildren();
  for(const c of state.picks.values()){
    const row=el('li');row.title=c.name;
    const remove=button('×',()=>togglePick(c),'side-picks-remove');remove.setAttribute('aria-label',c.name+' 빼기');
    row.append(el('span','',c.name),remove);list.append(row);
  }
  list.scrollTop=list.scrollHeight;
}
async function openSelectedBatch(){
  if(!state.picks.size){notify('분석할 회사를 체크해 주세요.');return;}
  page('batch');window.scrollTo(0,0);await runBatch();
}
async function pickAllResults(){
  const params=p=>new URLSearchParams({q:$('query').value.trim(),category:state.category,page:p,sort:$('search-sort').value,size:MAX_PICKS,favorites:$('search-favorites')?.checked?'1':'0'});
  const trigger=$('pick-all'),label=trigger.textContent;trigger.disabled=true;trigger.textContent='선택 중…';
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
  notify(`${added}개 회사를 선택했습니다.`+(skipped?` 최대 ${MAX_PICKS}개까지 선택할 수 있어 ${skipped}개는 제외했습니다.`:''));
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
    if(!data.asOf){$('batch-status').textContent='선택한 회사들의 핵심 재무 비교 자료가 없습니다. 개별 회사의 사업·재무 보기에서 저장된 결과를 확인하거나 분석을 요청하세요.';return;}
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
  bar.append(heading,actions);root.append(bar,el('p','unit-label','금액: 억원 · 비율: % · 숫자 또는 —를 누르면 출처·누락 이유를 확인합니다. 빈칸은 0이나 미공시 확정이 아닙니다. Excel에는 원자료와 실제 수식이 포함됩니다.'));
  const cols=[['revenue','매출액'],['operatingIncome','영업이익'],['operatingMargin','영업이익률',1],['netIncome','당기순이익'],
    ...(options.cashflow?[['operatingCashFlow','영업현금흐름']]:[]),['assets','자산총계'],['liabilities','부채총계'],['equity','자본총계'],['debtRatio','부채비율',1],['revenueGrowth','매출성장률',1]];
  const fmt=(v,pct)=>v===null||v===undefined?'—':new Intl.NumberFormat('ko-KR',{maximumFractionDigits:1}).format(v)+(pct?'%':'');
  const table=el('table'),thead=el('thead'),head=el('tr');
  head.append(el('th','','회사'),el('th','','기준'),...cols.map(([,label])=>el('th','',label)));thead.append(head);table.append(thead);
  const body=el('tbody');
  for(const c of data.companies){
    const r=c.rows.find(x=>x.year===state.batchYear)||{},row=el('tr',c.found?'':'missing');
    row.append(el('th','',c.name),el('td','',c.basisLabel),...cols.map(([k,label,pct])=>{
      const cell=el('td');cell.append(button(fmt(r[k],pct),()=>{
        const box=dialog(`${c.name} · ${r.year}년 · ${label}`);
        box.append(el('p','',`재무 기준: ${c.basisLabel} · ${r.year} 사업연도 · 연간`),el('h3','',fmt(r[k],pct)));
        box.append(el('p','scope-note','출처: Open DART 공용 재무 캐시 · 원문 접수번호/위치/개별 실패 이력은 이 캐시에 저장되지 않습니다.'));
        box.append(el('p','',`캐시 갱신 시각: ${r.source?.updated||'기록 없음'} (공시일과 다를 수 있음)`));
        if(r[k]==null)box.append(el('p','quality-warning',r.missing?.[k]||'계산 입력값 누락 또는 분모 0 · Excel 원자료와 계산식을 확인하세요.'));
        else if(c.rawYears?.[r.year]?.[k]!=null)box.append(el('pre','raw-values',`수집 금액: ${c.rawYears[r.year][k].toLocaleString()}원\n환산: 원 ÷ 100,000,000`));
        box.append(el('p','scope-note','원문 접수번호·계정별 근거가 필요하면 이 회사의 개별 상세 분석 결과에서 확인하세요.'));
      },'value-button'));return cell;
    }));body.append(row);
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
$('search-favorites')?.addEventListener('change',()=>{if($('search-favorites').checked){$('query').value='';state.category='';renderCategories();}search().catch(e=>notify(e.message));});
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
for(const id of ['batch-clear','pick-tray-clear','selection-clear'])$(id).addEventListener('click',()=>{state.picks.clear();renderPicks();});
$('notice').addEventListener('click',()=>notify());
// On phones the menu row stays pinned while the logo above it scrolls away; measure the logo
// instead of assuming its height, which differs with the phone's fonts.
// While the app is still hidden behind the sign-in screen the height reads 0; page() measures again.
function pinMenu(){const nav=document.querySelector('.sidebar nav');if(nav?.offsetTop)document.querySelector('.sidebar').style.setProperty('--menu-offset',nav.offsetTop+'px');}
pinMenu();window.addEventListener('resize',pinMenu);document.fonts?.ready.then(pinMenu);
for(const id of ['pick-tray-open','selection-analyze'])$(id).addEventListener('click',()=>openSelectedBatch().catch(e=>notify(e.message)));
$('batch-form').addEventListener('submit',e=>{e.preventDefault();runBatch().catch(error=>notify(error.message));});
$('refresh-jobs').addEventListener('click',()=>refreshJobs().catch(e=>notify(e.message)));
$('close-dialog').addEventListener('click',()=>$('detail-dialog').close());
setInterval(()=>{if(!$('app').classList.contains('hidden'))refreshJobs().catch(e=>notify(e.message));},2500);
api('/api/session').then(s=>{$('logout').classList.toggle('hidden',!s.passwordRequired);return s.authenticated?initialize():showLogin();}).catch(e=>{showLogin();$('login-error').textContent=e.message;});
let cloudRefresh;
window.addEventListener('dart-cloud-change',()=>{clearTimeout(cloudRefresh);cloudRefresh=setTimeout(()=>{if(!$('app').classList.contains('hidden')){refreshJobs().catch(e=>notify(e.message));if(!$('page-library').classList.contains('hidden'))loadLibrary(state.libraryPage).catch(e=>notify(e.message));}},250);});
