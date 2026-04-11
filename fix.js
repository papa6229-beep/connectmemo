const fs = require('fs');
let code = fs.readFileSync('src/extension.ts', 'utf8');
let lines = code.split('\n');

const correctCode = `  t=t.replace(/<create_file\\\\s+path="([^"]+)">([\\\\s\\\\S]*?)<\\\\/create_file>/g,(_,p,c)=>'<div class="file-badge">\\ud83d\\udcc1 '+esc(p)+' \\u2014 \\uc790\\ub3d9 \\uc0dd\\uc131\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(/<edit_file\\\\s+path="([^"]+)">([\\\\s\\\\S]*?)<\\\\/edit_file>/g,(_,p,c)=>'<div class="edit-badge">\\u270f\\ufe0f '+esc(p)+' \\u2014 \\ud3b8\\uc9d1\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(/<run_command>([\\\\s\\\\S]*?)<\\\\/run_command>/g,(_,c)=>'<div class="cmd-badge">\\u25b6 '+esc(c)+'</div>');
  t=t.replace(/\\\`\\\`\\\`(\\\\w*)\\\\n([\\\\s\\\\S]*?)\\\`\\\`\\\`/g,(_,lang,c)=>{const l=lang||'code';return '<div class="code-wrap"><span class="code-lang">'+l+'</span><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'});
  t=t.replace(/\\\`([^\\\`]+)\\\`/g,(_,c)=>'<code>'+esc(c)+'</code>');
  t=t.replace(/\\\\*\\\\*([^*]+)\\\\*\\\\*/g,'<strong>$1</strong>');`;

lines.splice(614, 7, correctCode);
fs.writeFileSync('src/extension.ts', lines.join('\n'));
console.log('Fixed regex lines!');
