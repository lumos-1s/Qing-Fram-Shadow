// XMP 导入功能测试：映射正确性 + UI 按钮
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'src', 'renderer');

app.commandLine.appendSwitch('disable-gpu');
app.commandLine.appendSwitch('disable-software-rasterizer');
app.commandLine.appendSwitch('no-sandbox');

const SAMPLE_XMP = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Adobe XMP Core 5.6-c148 79.163756, 2019/08/07-13:41:36        ">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="15.4"
    crs:ProcessVersion="11.0"
    crs:WhiteBalance="As Shot"
    crs:Temperature="+38"
    crs:Tint="+10"
    crs:Exposure2012="+0.50"
    crs:Contrast2012="+25"
    crs:Highlights2012="-40"
    crs:Shadows2012="+30"
    crs:Whites2012="-12"
    crs:Blacks2012="-18"
    crs:Clarity2012="+10"
    crs:Texture="+15"
    crs:Dehaze="+20"
    crs:Vibrance="+25"
    crs:Saturation="+5"
    crs:ToneCurvePV2012="0, 0, 32, 22, 64, 56, 128, 128, 192, 196, 224, 232, 255, 255"
    crs:HueAdjustmentRed="+10"
    crs:SaturationAdjustmentRed="-20"
    crs:LuminanceAdjustmentAqua="+15"
    crs:RedHue="-5"
    crs:BlueSaturation="+12"
    crs:SharpenAmount="+25"
    crs:NoiseReductionLuminance="+20">
   <crs:HasSettings>True</crs:HasSettings>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1400, height: 800, show: false,
    webPreferences: { preload: path.join(__dirname, 'preload-measure.js'), contextIsolation: true, nodeIntegration: false }
  });
  await win.loadFile(path.join(RENDERER, 'index.html'));
  await new Promise(r => setTimeout(r, 1000));

  const results = await win.webContents.executeJavaScript(`(async function(){
    const out = [];
    const ok = (name, cond, extra) => out.push((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra ? ' | ' + extra : ''));
    const R = window.AppXmp && window.AppXmp.mapXmp;
    ok('AppXmp 挂载', !!R);
    if (!R) return out.join('\\n');
    const m = R(${JSON.stringify(SAMPLE_XMP)});

    // 基础档
    ok('曝光 +0.50EV → exp=30', m.patch.exp === 30, 'exp=' + m.patch.exp);
    ok('对比度 +25 → con=25', m.patch.con === 25);
    ok('饱和度: sat=5 且 vibrance=25×0.5 折入 → 18', m.patch.sat === 18, 'sat=' + m.patch.sat + ' vib=' + m.patch.vib);
    ok('高光 -40 → hi=-40', m.patch.hi === -40);
    ok('阴影 +30 → sh=30', m.patch.sh === 30);
    ok('白色 -12 → white=-12', m.patch.white === -12);
    ok('黑色 -18 → black=-18', m.patch.black === -18);
    ok('色温 +38 → temp=38', m.patch.temp === 38);
    ok('色调 +10 → tint=10', m.patch.tint === 10);

    // 细节/校准/混色器
    ok('细节 clar/tex/dhz=10/15/20', m.patch.det && m.patch.det.clar === 10 && m.patch.det.tex === 15 && m.patch.det.dhz === 20, JSON.stringify(m.patch.det));
    ok('校准 rh=-5 bs=12', m.patch.cal && m.patch.cal.rh === -5 && m.patch.cal.bs === 12, JSON.stringify(m.patch.cal));
    ok('混色器 r.h=10 r.s=-20', m.patch.mix && m.patch.mix.r && m.patch.mix.r.h === 10 && m.patch.mix.r.s === -20, JSON.stringify(m.patch.mix));
    ok('混色器 a.l=15', m.patch.mix && m.patch.mix.a && m.patch.mix.a.l === 15, JSON.stringify(m.patch.mix));

    // 曲线（0-255 → 0-1）
    const cv = m.patch.curve && m.patch.curve.rgb;
    ok('曲线存在且首点 0,0', cv && cv[0][0] === 0 && cv[0][1] === 0);
    ok('曲线 32,22 → 0.1255,0.0863', cv && Math.abs(cv[1][0] - 32/255) < 0.0001 && Math.abs(cv[1][1] - 22/255) < 0.0001, JSON.stringify(cv && cv[1]));
    ok('曲线尾点 255,255 → 1,1', cv && cv[cv.length-1][0] === 1 && cv[cv.length-1][1] === 1);

    // skipped
    ok('跳过清单含 SharpenAmount', m.skipped.indexOf('SharpenAmount') >= 0, m.skipped.join(','));
    ok('跳过清单含 NoiseReductionLuminance', m.skipped.indexOf('NoiseReductionLuminance') >= 0);
    ok('跳过清单含 WhiteBalance', m.skipped.indexOf('WhiteBalance') >= 0);
    ok('应用清单含 主曲线/红色HSL', m.applied.indexOf('主曲线') >= 0 && m.applied.indexOf('红色HSL') >= 0, m.applied.join(','));

    // hasAdjust
    ok('hasAdjust=true', m.hasAdjust === true);

    // UI 按钮
    const btn = document.getElementById('btnGradeImportXmp');
    ok('导入 LR 预设按钮存在', !!btn);
    ok('按钮标题正确', btn && btn.title.indexOf('Lightroom') >= 0, btn && btn.title);
    const scripts = Array.prototype.slice.call(document.querySelectorAll('script')).map(s => s.getAttribute('src') || '');
    ok('app-xmp.js 已引入', scripts.indexOf('js/app-xmp.js') >= 0);

    return out.join('\\n');
  })()`);
  console.log(results);
  const pass = (results.match(/PASS/g) || []).length;
  const fail = (results.match(/FAIL/g) || []).length;
  console.log('RESULT: ' + pass + ' PASS / ' + fail + ' FAIL');
  app.exit(0);
}).catch(e => { console.error('ERR', e); app.exit(1); });
