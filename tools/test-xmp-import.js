// XMP 导入功能测试：映射正确性 + 颜色分级 UI
const { app, BrowserWindow } = require('electron');
const path = require('path');

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
    crs:Version="11.3.1"
    crs:ProcessVersion="10.0"
    crs:WhiteBalance="Custom"
    crs:Temperature="4769"
    crs:Tint="+38"
    crs:Exposure2012="+0.56"
    crs:Contrast2012="+20"
    crs:Highlights2012="-100"
    crs:Shadows2012="-30"
    crs:Whites2012="+23"
    crs:Blacks2012="+26"
    crs:Clarity2012="0"
    crs:Texture="+37"
    crs:Dehaze="+20"
    crs:Vibrance="+5"
    crs:Saturation="-6"
    crs:HueAdjustmentRed="+10"
    crs:SaturationAdjustmentRed="-20"
    crs:LuminanceAdjustmentAqua="+15"
    crs:RedHue="-5"
    crs:BlueSaturation="+12"
    crs:SplitToningShadowHue="200"
    crs:SplitToningShadowSaturation="13"
    crs:SplitToningHighlightHue="80"
    crs:SplitToningHighlightSaturation="12"
    crs:SplitToningBalance="0"
    crs:ParametricShadows="0"
    crs:ParametricDarks="+50"
    crs:ParametricLights="0"
    crs:ParametricHighlights="0"
    crs:ParametricShadowSplit="10"
    crs:ParametricMidtoneSplit="59"
    crs:ParametricHighlightSplit="90"
    crs:SharpenAmount="+25"
    crs:NoiseReductionLuminance="+20">
   <crs:HasSettings>True</crs:HasSettings>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>`;

const POINT_XMP = SAMPLE_XMP
  .replace('crs:ParametricDarks="+50"', 'crs:ParametricDarks="0"')
  .replace('crs:ParametricShadowSplit="10"', 'crs:ParametricShadowSplit="25"')
  .replace('crs:ParametricMidtoneSplit="59"', 'crs:ParametricMidtoneSplit="50"')
  .replace('crs:ParametricHighlightSplit="90"', 'crs:ParametricHighlightSplit="75"')
  .replace('crs:NoiseReductionLuminance="+20">',
    'crs:NoiseReductionLuminance="+20"\n    crs:ToneCurvePV2012="0, 0, 32, 22, 64, 56, 128, 128, 192, 196, 224, 232, 255, 255">');

const AS_SHOT_XMP = SAMPLE_XMP.replace('crs:WhiteBalance="Custom"', 'crs:WhiteBalance="As Shot"');

const MODERN_CG_XMP = SAMPLE_XMP
  .replace(/crs:SplitToning[^\s>]+/g, '')
  .replace('crs:NoiseReductionLuminance="+20">',
    'crs:NoiseReductionLuminance="+20"\n    crs:ColorGradeMidtoneHue="268"\n    crs:ColorGradeMidtoneSat="40"\n    crs:ColorGradeMidtoneLum="10"\n    crs:ColorGradeShadowSat="0"\n    crs:ColorGradeBalance="20"\n    crs:ColorGradeBlending="50">');

const GRAY_XMP = SAMPLE_XMP
  .replace('crs:Saturation="-6"', 'crs:Saturation="+10"\n    crs:ConvertToGrayscale="True"');

const LEGACY_XMP = `<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
 crs:WhiteBalance="Custom" crs:Temperature="5500" crs:Tint="0"
 crs:Exposure="+1.00" crs:Contrast="+10" crs:Clarity="+15" crs:Vibrance="+20"
 crs:HasSettings="True"/></rdf:RDF></x:xmpmeta>`;

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

    // 基础档：EV / 自然饱和度不再折入饱和度
    ok('曝光 +0.56EV → exp=0.56', m.patch.exp === 0.56, 'exp=' + m.patch.exp);
    ok('对比度 +20 → con=20', m.patch.con === 20);
    ok('饱和度 -6 与自然饱和度 +5 分开', m.patch.sat === -6 && m.patch.vib === 5,
        'sat=' + m.patch.sat + ' vib=' + m.patch.vib);
    ok('高光 -100 → hi=-100', m.patch.hi === -100);
    ok('阴影 -30 → sh=-30', m.patch.sh === -30);
    ok('白色 +23 → white=23', m.patch.white === 23);
    ok('黑色 +26 → black=26', m.patch.black === 26);
    // 4769K 相对 5500K 的 mired 差 ×0.75 → -21
    ok('色温 4769K → temp=-21（不再被截成 ±100）', m.patch.temp === -21, 'temp=' + m.patch.temp);
    ok('色调 +38 → tint=38（LR 正向=品红）', m.patch.tint === 38);

    // 细节/校准/混色器
    ok('细节 clar/tex/dhz=0/37/20', m.patch.det && m.patch.det.clar === 0
        && m.patch.det.tex === 37 && m.patch.det.dhz === 20, JSON.stringify(m.patch.det));
    ok('校准 rh=-5 bs=12', m.patch.cal && m.patch.cal.rh === -5 && m.patch.cal.bs === 12, JSON.stringify(m.patch.cal));
    ok('混色器 r.h=10 r.s=-20', m.patch.mix && m.patch.mix.r
        && m.patch.mix.r.h === 10 && m.patch.mix.r.s === -20, JSON.stringify(m.patch.mix));
    ok('混色器 a.l=15', m.patch.mix && m.patch.mix.a && m.patch.mix.a.l === 15, JSON.stringify(m.patch.mix));

    // 参数曲线：真实 LR 预设大量使用；不能整条丢掉
    const cv = m.patch.curve && m.patch.curve.rgb;
    ok('参数曲线生成（17 个点）', cv && cv.length === 17, 'len=' + (cv && cv.length));
    const midY = cv && cv[8] && cv[8][1];
    ok('ParametricDarks +50 抬高中间调', midY > 0.52, 'midY=' + midY);
    ok('曲线首尾锚定 0/1', cv && cv[0][0] === 0 && cv[cv.length - 1][0] === 1);

    // 旧版 SplitToning → 颜色分级
    const cg = m.patch.cg;
    ok('分离色调映射到颜色分级', !!cg, JSON.stringify(cg));
    ok('阴影 200°/13，高光 80°/12',
        cg && cg.shadow.h === 200 && cg.shadow.s === 13 && cg.high.h === 80 && cg.high.s === 12,
        JSON.stringify(cg));
    ok('Blending 默认 50，Balance=0', cg && cg.blending === 50 && cg.balance === 0);

    // 应用/跳过清单
    ok('应用清单含 参数曲线/分离色调/自然饱和度',
        m.applied.indexOf('参数曲线') >= 0 && m.applied.indexOf('分离色调') >= 0
        && m.applied.indexOf('自然饱和度') >= 0, m.applied.join(','));
    ok('跳过清单含 SharpenAmount/NoiseReductionLuminance',
        m.skipped.indexOf('SharpenAmount') >= 0 && m.skipped.indexOf('NoiseReductionLuminance') >= 0,
        m.skipped.join(','));
    ok('WhiteBalance 已消费，不再进跳过清单', m.skipped.indexOf('WhiteBalance') < 0, m.skipped.join(','));

    // 点曲线（0-255 → 0-1）仍保留原始控制点
    const mp = R(${JSON.stringify(POINT_XMP)});
    const cp = mp.patch.curve && mp.patch.curve.rgb;
    ok('点曲线 32,22 → 0.1255,0.0863', cp && Math.abs(cp[1][0] - 32 / 255) < 0.0001
        && Math.abs(cp[1][1] - 22 / 255) < 0.0001, JSON.stringify(cp && cp[1]));
    ok('点曲线尾点 255,255 → 1,1', cp && cp[cp.length - 1][0] === 1 && cp[cp.length - 1][1] === 1);

    // As Shot：不能把预设参考照片的绝对色温套到新照片
    const ma = R(${JSON.stringify(AS_SHOT_XMP)});
    ok('WhiteBalance=As Shot 时不套用 Temperature/Tint',
        ma.patch.temp === undefined && ma.patch.tint === undefined,
        'temp=' + ma.patch.temp + ' tint=' + ma.patch.tint);
    ok('As Shot 在跳过清单里有说明', ma.skipped.some(x => /随照片/.test(x)), ma.skipped.join(','));

    // 现代 ColorGrade
    const mg = R(${JSON.stringify(MODERN_CG_XMP)});
    ok('现代 ColorGradeMidtone 映射到 cg.mid',
        mg.patch.cg && mg.patch.cg.mid.h === 268 && mg.patch.cg.mid.s === 40 && mg.patch.cg.mid.l === 10,
        JSON.stringify(mg.patch.cg));
    ok('ColorGradeBalance/Blending 保留', mg.patch.cg && mg.patch.cg.balance === 20
        && mg.patch.cg.blending === 50, JSON.stringify(mg.patch.cg));

    // 黑白
    const mb = R(${JSON.stringify(GRAY_XMP)});
    ok('ConvertToGrayscale=True → sat=-100 且清掉自然饱和度',
        mb.patch.sat === -100 && mb.patch.vib === undefined, JSON.stringify(mb.patch));

    // 旧 Process Version 字段兜底
    const ml = R(${JSON.stringify(LEGACY_XMP)});
    ok('旧版 Exposure/Contrast/Clarity 兜底', ml.patch.exp === 1 && ml.patch.con === 10
        && ml.patch.det && ml.patch.det.clar === 15, JSON.stringify(ml.patch));
    ok('旧版 Vibrance 单独保留', ml.patch.vib === 20, 'vib=' + ml.patch.vib);

    // UI
    const btn = document.getElementById('btnGradeImportXmp');
    ok('导入 LR 预设按钮存在', !!btn);
    ok('按钮标题提到颜色分级', btn && btn.title.indexOf('颜色分级') >= 0, btn && btn.title);
    ok('自然饱和度滑块存在', !!document.getElementById('slGradeVib'));
    ok('颜色分级组存在', !!document.getElementById('grpColorGrade'));
    const zones = Array.prototype.slice.call(document.querySelectorAll('#cgZones .curve-chan'));
    ok('颜色分级四个区域页签', zones.map(x => x.dataset.cg).join(',') === 'shadow,mid,high,global',
        zones.map(x => x.dataset.cg).join(','));
    ok('颜色分级色相/饱和/明亮/混合/平衡滑块齐全',
        ['slCgHue', 'slCgSat', 'slCgLum', 'slCgBlending', 'slCgBalance'].every(id => !!document.getElementById(id)));
    ok('QfsColor 后置 pass 已挂载', !!(window.QfsColor && window.QfsColor.pass));
    ok('App.CG_ZONES 四个区域', window.App && window.App.CG_ZONES && window.App.CG_ZONES.length === 4);
    const scripts = Array.prototype.slice.call(document.querySelectorAll('script')).map(s => s.getAttribute('src') || '');
    ok('app-xmp.js 已引入', scripts.indexOf('js/app-xmp.js') >= 0);
    ok('app-color-grade.js 已引入', scripts.indexOf('js/app-color-grade.js') >= 0);

    return out.join('\\n');
  })()`);
  console.log(results);
  const pass = (results.match(/PASS/g) || []).length;
  const fail = (results.match(/FAIL/g) || []).length;
  console.log('RESULT: ' + pass + ' PASS / ' + fail + ' FAIL');
  app.exit(fail ? 1 : 0);
}).catch(e => { console.error('ERR', e); app.exit(1); });
