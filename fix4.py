import sys

with open('src/extension.ts', 'r') as f:
    text = f.read()

start_idx = text.find('function fmt(t){')
end_idx = text.find('function copyCode(btn)')

# I will avoid ALL slashes and regex literals entirely, and use purely new RegExp("...", "g") syntax with properly escaped backslashes for JS strings.
new_fmt = """function fmt(t){
  t=t.replace(new RegExp('<create_file\\\\\\\\s+path="([^"]+)">([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/create_file>', 'g'),(_,p,c)=>'<div class="file-badge">\\uD83D\\uDCC1 '+esc(p)+' \\u2014 \\uC790\\uB3D9 \\uC0DD\\uC131\\uB428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(new RegExp('<edit_file\\\\\\\\s+path="([^"]+)">([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/edit_file>', 'g'),(_,p,c)=>'<div class="edit-badge">\\u270F\\uFE0F '+esc(p)+' \\u2014 \\uD3B8\\uC9D1\\uB428</div><div class="code-wrap"><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>');
  t=t.replace(new RegExp('<run_command>([\\\\\\\\s\\\\\\\\S]*?)<\\\\\\\\/run_command>', 'g'),(_,c)=>'<div class="cmd-badge">\\u25B6 '+esc(c)+'</div>');
  t=t.replace(new RegExp('\\\\\\\\`\\\\\\\\`\\\\\\\\`(\\\\\\\\w*)\\\\\\\\n([\\\\\\\\s\\\\\\\\S]*?)\\\\\\\\`\\\\\\\\`\\\\\\\\`', 'g'),(_,lang,c)=>{const l=lang||'code';return '<div class="code-wrap"><span class="code-lang">'+l+'</span><pre><code>'+esc(c)+'</code></pre><button class="copy-btn" onclick="copyCode(this)">Copy</button></div>'});
  t=t.replace(new RegExp('\\\\\\\\`([^\\\\\\\\`]+)\\\\\\\\`', 'g'),(_,c)=>'<code>'+esc(c)+'</code>');
  t=t.replace(new RegExp('\\\\\\\\*\\\\\\\\*([^*]+)\\\\\\\\*\\\\\\\\*', 'g'),'<strong>$1</strong>');
  return t;
}
"""

if start_idx != -1 and end_idx != -1:
    text = text[:start_idx] + new_fmt + text[end_idx:]
    with open('src/extension.ts', 'w') as f:
        f.write(text)
    print("Fixed!")
