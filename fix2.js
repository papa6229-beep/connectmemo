const fs = require('fs');
let code = fs.readFileSync('src/extension.ts', 'utf8');
let lines = code.split('\n');

const correctCode = `function fmt(t){
  // Use new RegExp with string literals to avoid ALL JS parser escaping hell with regex literals containing forward slashes
  const createRe = new RegExp('<create_file\\\\\\\\s+path="([^"]+)">([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/create_file>', 'g');
  const editRe = new RegExp('<edit_file\\\\\\\\s+path="([^"]+)">([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/edit_file>', 'g');
  const runRe = new RegExp('<run_command>([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/run_command>', 'g');
  const mdCodeRe = new RegExp('\\\\`\\\\`\\\\`(\\\\\\\\w*)\\\\\\\\n([\\\\\\\\s\\\\\\\\S]*?)\\\\`\\\\`\\\\`', 'g');
  const inlineCodeRe = new RegExp('\\\\`([^\\\\`]+)\\\\`', 'g');
  const boldRe = new RegExp('\\\\\\\\*\\\\\\\\*([^*]+)\\\\\\\\*\\\\\\\\*', 'g');

  t=t.replace(createRe,(_,p,c)=>'<div class="file-badge">\\ud83d\\udcc1 '+esc(p)+' \\u2014 \\uc790\\ub3d9 \\uc0dd\\uc131\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(editRe,(_,p,c)=>'<div class="edit-badge">\\u270f\\ufe0f '+esc(p)+' \\u2014 \\ud3b8\\uc9d1\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(runRe,(_,c)=>'<div class="cmd-badge">\\u25b6 '+esc(c)+'</div>');
  t=t.replace(mdCodeRe,(_,lang,c)=>{const l=lang||'code';return '<div class="code-wrap"><span class="code-lang">'+l+'</span><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'});
  t=t.replace(inlineCodeRe,(_,c)=>'<code>'+esc(c)+'</code>');
  t=t.replace(boldRe,'<strong>$1</strong>');
  return t;
}`;

// Find where function fmt(t){ starts and replace it
let start = lines.findIndex(l => l.includes('function fmt(t){'));
let end = lines.findIndex((l, i) => i > start && l.includes('return t;')) + 1;
lines.splice(start, end - start + 1, correctCode);
fs.writeFileSync('src/extension.ts', lines.join('\n'));
console.log('Fixed regex lines with RegExp approach!');
