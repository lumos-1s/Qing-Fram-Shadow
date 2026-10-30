const fs = require('fs');
const presets = [
    { name: '签名纪念', tag: '个性', style: 'SIGNATURE', signature: '' },
    { name: '签名+参数', tag: '个性', style: 'SIGN_PARAM', signature: '' },
    { name: '头像纪念', tag: '个性', style: 'AVATAR_MEMO', signature: '' },
];

presets.forEach(p => {
    const obj = {
        templateName: p.name,
        templateTag: p.tag,
        exportDpi: 300,
        baseMargin: { marginLock: 0, marginTop: 0, marginBottom: 0, marginLeft: 0, marginRight: 0, imgScale: 1, imgOffsetX: 0, imgOffsetY: 0, bgBlurEnable: 0, bgBlurRadius: 30, bgBlurWhiteOverlay: 0 },
        layerList: [],
        cornerConfig: { cornerLock: 1, cornerRadiusAll: 0, cornerRadiusTL: 0, cornerRadiusTR: 0, cornerRadiusBL: 0, cornerRadiusBR: 0 },
        filmTearConfig: { filmPerforationEnable: 0, filmPerforationType: 'round', filmPerforationSize: 15, filmPerforationSpacing: 30 },
        lightEffect: { vignetteEnable: 0, vignetteStrength: 35, vignetteFeather: 50, lightLeakEnable: 0, lightLeakType: 'warm', lightLeakOpacity: 20, lightLeakAngle: 45, filmGrainEnable: 0, filmGrainIntensity: 10 },
        decorConfig: { textLines: [], stickers: [], cornerDecorEnable: 0, cornerDecorType: 'none', cornerDecorSize: 30, exifAutoText: 0 },
        logoElements: [],
        paramFontSize: 33,
        paramType: 0,
        paramPosition: 'RIGHT',
        photoFrameStyle: p.style,
        photoFrameBorderSize: 100,
        blurIntensity: 50,
        userSignature: p.signature
    };
    fs.writeFileSync(`shared/presets/${p.name}.json`, JSON.stringify(obj, null, 2), 'utf8');
    console.log('created:', p.name);
});
