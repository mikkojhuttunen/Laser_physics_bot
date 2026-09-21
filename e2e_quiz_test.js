process.env.ANTHROPIC_API_KEY='dummy';
const single=require('./quizGenerator_fys501.js'), multi=require('./multivalueQuizGenerator_fys501.js');
const sBank=require('./quizBank_fys501.json'), mBank=require('./multivalueQuizBank_fys501.json');
const flat=b=>Object.values(b).flatMap(c=>Object.values(c).flat());
const unesc=s=>s.replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&amp;/g,'&');
const sByStem=new Map(flat(sBank).map(q=>[q.stem,q])), mByStem=new Map(flat(mBank).map(q=>[q.stem,q]));
const sections=Object.values(sBank).flatMap(c=>Object.keys(c));
function mkBot(){ const log={sent:[],edits:[],toasts:0}; let mid=1;
  return {log, sendMessage:async(c,t,o)=>{log.sent.push({c,t,o,mid:mid});return {message_id:mid++};}, editMessageText:async(t,o)=>{log.edits.push({t,o});return {};}, answerCallbackQuery:async()=>{log.toasts++;} }; }
const problems=[]; const note=(m)=>problems.push(m);
const parseOpts=t=>[...t.matchAll(/<b>([A-F])\)<\/b> (.*)/g)].map(m=>({L:m[1],text:m[2]}));

async function playSingle(sec,chatId,strategy){
  const bot=mkBot(); await single.startQuiz(bot,chatId,`quiz me on section ${sec}, 8 questions`,undefined,chatId);
  let idx=0, score=0, lastLen=0;
  const positions=[];
  for(;;){
    const m=bot.log.sent[bot.log.sent.length-1]; if(!m||!/Question \d+\/8/.test(m.t)){ if(m&&/Quiz complete/.test(m.t)) break; note(`${sec}: unexpected message: ${m&&m.t.slice(0,80)}`); return null; }
    if(m.t.length>4000) note(`${sec}: msg too long`);
    const stem=(m.t.match(/<\/b>\n\n([\s\S]*?)\n\n<b>A\)/)||[])[1]; const q=sByStem.get(stem); if(!q){note(`${sec}: stem not in bank: ${stem.slice(0,50)}`);return null;}
    const opts=parseOpts(m.t); if(opts.length!==4) note(`${sec}: ${q.id} shows ${opts.length} options`);
    if([...opts.map(o=>o.text)].sort().join('|')!==[...q.options].sort().join('|')) note(`${sec}: ${q.id} displayed options differ from bank set`);
    const correctText=q.options[q.correctIndex]; const cI=opts.findIndex(o=>o.text===correctText);
    positions.push(cI);
    let pick = strategy==='correct'?cI : strategy==='A'?0 : strategy==='longest'?opts.reduce((b,o,i)=>o.text.length>opts[b].text.length?i:b,0) : 0;
    const before=bot.log.edits.length;
    await single.handleQuizAnswer(bot,{id:'x',data:`quiz:${idx}:${pick}`,message:{chat:{id:chatId},message_id:m.mid}});
    const e=bot.log.edits[before]; if(!e){note(`${sec}: no edit`);return null;}
    const wasCorrect=pick===cI; if(wasCorrect!==/✅ Correct/.test(e.t)) note(`${sec}: ${q.id} feedback mismatch`);
    if(!wasCorrect && !e.t.includes(`<b>${'ABCD'[cI]})</b> ${correctText}`)) note(`${sec}: ${q.id} wrong-answer feedback names wrong letter`);
    if(e.t.length>4096) note(`${sec}: edit too long`);
    if(wasCorrect) score++; idx++;
  }
  const fin=bot.log.sent[bot.log.sent.length-1].t; const s=+fin.match(/Score: (\d+)\/8/)[1]; if(s!==score) note(`${sec}: score mismatch ${s} vs ${score}`);
  return {score,positions};
}
async function playMulti(sec,chatId,strategy){
  const bot=mkBot(); await multi.startMultivalueQuiz(bot,chatId,`mvquiz section ${sec}, 8 questions`,undefined,chatId);
  let idx=0, total=0;
  for(;;){
    const m=bot.log.sent[bot.log.sent.length-1]; if(/Multi-select quiz complete/.test(m.t)){ return +m.t.match(/\((\d+)%\)/)[1]; }
    if(!/\d+\/8/.test(m.t)){note(`mv ${sec}: unexpected ${m.t.slice(0,80)}`);return null;}
    if(m.t.length>4000) note(`mv ${sec}: msg too long`);
    const stemLine=unesc(m.t.split('\n')[2]||''); let q=[...mByStem.values()].find(x=>m.t.includes(x.stem.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')));
    if(!q){note(`mv ${sec}: stem not found`);return null;}
    const opts=[...m.t.matchAll(/<b>([A-H])\)<\/b> (.*)/g)].map(x=>({L:x[1],text:unesc(x[2])}));
    if(opts.length!==q.options.length) note(`mv ${sec}: ${q.id} ${opts.length} options shown`);
    const want = strategy==='correct'? q.correctIndices.map(i=>opts.findIndex(o=>o.text===q.options[i])) : opts.map((_,i)=>i);
    const sid=m.o.reply_markup.inline_keyboard[0][0].callback_data.split(':')[1];
    const rk=()=>bot.log.edits.length?bot.log.edits[bot.log.edits.length-1].o.reply_markup:m.o.reply_markup;
    for(const i of want){ await multi.handleMultivalueQuizAnswer(bot,{id:'x',data:`mv:${sid}:${idx}:t:${i}`,message:{chat:{id:chatId},message_id:m.mid}}); }
    const nSent=bot.log.sent.length;
    await multi.handleMultivalueQuizAnswer(bot,{id:'x',data:`mv:${sid}:${idx}:s`,message:{chat:{id:chatId},message_id:m.mid}});
    idx++;
  }
}
(async()=>{
  let cnt=0, tot=0, posAll=[0,0,0,0], longestHits=0, aHits=0;
  for(const [i,s] of sections.entries()){
    const r=await playSingle(s,2000+i,'correct'); if(r){ if(r.score!==8) note(`${s}: correct-play scored ${r.score}/8`); r.positions.forEach(p=>posAll[p]++); cnt++; }
    const l=await playSingle(s,3000+i,'longest'); if(l) longestHits+=l.score;
    const a=await playSingle(s,4000+i,'A'); if(a) aHits+=a.score;
  }
  console.log(`SINGLE: ${cnt}/20 sections played 8/8 with correct picks | shown-position freq of correct answer A-D: ${posAll.join(', ')} | "always longest" strategy: ${longestHits}/160 (${(longestHits/1.6).toFixed(0)}%) | "always A": ${aHits}/160 (${(aHits/1.6).toFixed(0)}%)`);
  let mc=0, mAll=0;
  for(const [i,s] of sections.entries()){ const p=await playMulti(s,5000+i,'correct'); if(p===100) mc++; else note(`mv ${s}: correct-play scored ${p}%`); const t=await playMulti(s,6000+i,'all'); mAll+=t; }
  console.log(`MULTI: ${mc}/20 sections scored 100% with correct picks | "tick everything" avg score: ${(mAll/20).toFixed(1)}%`);
  console.log('PROBLEMS:',problems.length?problems.slice(0,15):'none');
})().catch(e=>{console.error('CRASH',e);process.exit(1);});
