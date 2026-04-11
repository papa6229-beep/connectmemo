import sys

with open('src/extension.ts', 'r') as f:
    content = f.read()

start_idx = content.find('function fmt(t){')
end_idx = content.find('function copyCode(btn)')

if start_idx != -1 and end_idx != -1:
    new_fmt = """function fmt(t){
  // Use simple string templates without regex literals
  t=t.replace(new RegExp('<create_file\\\\s+path="([^"]+)">([\\\\s\\\\S]*?)<\\\\/create_file>', 'g'),(_,p,c)=>'<div class="file-badge">\\ud83d\\udcc1 '+esc(p)+' \\u2014 \\uc790\\ub3d9 \\uc0dd\\uc131\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(new RegExp('<edit_file\\\\s+path="([^"]+)">([\\\\s\\\\S]*?)<\\\\/edit_file>', 'g'),(_,p,c)=>'<div class="edit-badge">\\u270f\\ufe0f '+esc(p)+' \\u2014 \\ud3b8\\uc9d1\\ub428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(new RegExp('<run_command>([\\\\s\\\\S]*?)<\\\\/run_command>', 'g'),(_,c)=>'<div class="cmd-badge">\\u25b6 '+esc(c)+'</div>');
  t=t.replace(new RegExp('\\\\`\\\\`\\\\`(\\\\w*)\\\\n([\\\\s\\\\S]*?)\\\\`\\\\`\\\\`', 'g'),(_,lang,c)=>{const l=lang||'code';return '<div class="code-wrap"><span class="code-lang">'+l+'</span><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'});
  t=t.replace(new RegExp('\\\\`([^\\\\`]+)\\\\`', 'g'),(_,c)=>'<code>'+esc(c)+'</code>');
  t=t.replace(new RegExp('\\\\*\\\\*([^*]+)\\\\*\\\\*', 'g'),'<strong>$1</strong>');
  return t;
}
"""
    new_content = content[:start_idx] + new_fmt + content[end_idx:]
    with open('src/extension.ts', 'w') as f:
        f.write(new_content)
    print("Successfully replaced fmt function.")
else:
    print("Could not find start or end index.")
