const partLabels = 'ACCESSORY BELT|AIR COMPRESSOR|AIR FILTER|ALTERNATOR|BATTERY|BRAKE CALIPER|BRAKE PAD|BRAKE ROTOR|CABIN FILTER|CAMSHAFT|CARBERATOR|CLUTCH PLATE|COIL SPRING|CRANKSHAFT|CYLINDER HEAD|DISTRIBUTOR|ENGINE BLOCK|ENGINE VALVE|FUEL INJECTOR|FUSE BOX|GAS CAP|GLOW PLUG|HEADLIGHTS|HIGH MOUNT STOP LAMP|IDLER ARM|IGNITION COIL|INSTRUMENT CLUSTER|LEAF SPRING|LOWER CONTROL ARM|MUFFLER|OIL FILTER|OIL PAN|OIL PRESSURE SENSOR|OVERFLOW TANK|OXYGEN SENSOR|PISTON|PRESSURE PLATE|RADIATOR|RADIATOR FAN|RADIATOR HOSE|RADIO|REVERSE LIGHT SWITCH|RIM|SHIFT KNOB|SIDE MIRROR|SPARK PLUG|SPOILER|STARTER|TAILLIGHTS|THERMOSTAT|TORQUE CONVERTER|TRANSMISSION|VACUUM BRAKE BOOSTER|VALVE LIFTER|WATER PUMP|WINDOW REGULATOR|WIPER BLADE';

export const identificationFormat = '只返回 JSON 对象，包含 kind、label、caption。先根据原图判断。kind 为 part（已认出具体汽配总成）、unclear（主体或总成归属无法确定）或 other（明确是其他日常画面）。caption 用日常中文说出具体配件和依据，英文分类代码仅写入 label。后窗台中央、驾驶室顶后缘中央的独立刹车灯是 HIGH MOUNT STOP LAMP；车尾两侧的组合尾灯是 TAILLIGHTS。两者要分别判断。part 的 label 使用下列对应英文类别，其他已明确的汽配用自己的英文名。类别：' + partLabels;

export function readDecision(text) {
  try {
    const value = JSON.parse(String(text).trim().replace(/^```(?:json)?\s*|\s*```$/gi, ''));
    return typeof value?.caption === 'string' && value.caption.trim() ? value : null;
  } catch { return null; }
}

export function galleryChoice({scene, strong, labels}) {
  if (scene?.strong) return scene.label;
  // The rear-only comparison cannot establish that a lamp is at the rear.
  if (['TAILLIGHTS','HIGH MOUNT STOP LAMP'].includes(scene?.expert?.preferred) &&
      scene.expert.rearComparison?.preferred) return scene.expert.rearComparison.preferred;
  if (scene?.expert?.preferred) return scene.expert.preferred;
  if (strong) return labels[0];
}

export function insufficient(text) {
  return !text || /(?:没看清|看不清|无法|不能|难以|未能|不足以|不确定).{0,12}(?:辨认|识别|确定|确认|判[定断]|归属|区分|看清)|没看清|看不清|归属未[定明]|^无法判断|^不确定/.test(text);
}

function ambiguousLamp({label, caption}) {
  const central = /高位(?:刹车|制动)灯|第三(?:刹车|制动)灯/.test(caption);
  const sharedBulb = /(?:前大灯|前照灯|大灯|近光灯?|远光灯?)\s*[（(]?\s*(?:或(?:者)?|也可能(?:是)?|[/／])\s*(?:前)?雾灯|雾灯\s*(?:或(?:者)?|[/／])\s*(?:大灯|前大灯|近光灯?)/.test(caption);
  return (label === 'HEADLIGHTS' && sharedBulb) ||
    (label === 'TAILLIGHTS' && central && !/不是高位|区别于高位/.test(caption)) ||
    /(?:高位(?:刹车|制动)灯|第三(?:刹车|制动)灯)\s*[/或]\s*(?:普通)?尾灯/.test(caption);
}

export function uncertainDecision(value) {
  return value?.kind === 'unclear' || (value?.kind === 'part' &&
    (typeof value.label !== 'string' || !value.label.trim() ||
      /^(?:LAMP_UNSPECIFIED|OTHER|UNKNOWN|UNSURE|UNCLEAR)$/i.test(value.label.trim()) || ambiguousLamp(value)));
}

// These categories frequently share a housing, a connector or the same camera view.
// A cue describes the target itself or an identifiable attachment point on the car.
const targetCues = {
  'OXYGEN SENSOR':['threaded_probe_with_vented_shield','probe_in_exhaust'],
  'BRAKE PAD WEAR SENSOR':['wire_to_pad_edge','clip_in_friction_material'],
  'THERMOSTAT':['coolant_valve_spring_and_bridge','thermostat_in_coolant_passage'],
  'TURN SIGNAL BULB':['amber_glass_and_bulb_contacts','bulb_in_indicator_socket'],
  'BRAKE PAD':['friction_layer_and_backplate','pad_ear_in_carrier'],
  'BRAKE CALIPER':['hydraulic_body','piston_or_slide_pin_in_carrier'],
  'BRAKE ROTOR':['hub_and_swept_disc'],
  'FUSE BOX':['fuses_or_relays','distribution_lid_diagram','dedicated_distribution_harness'],
  'BATTERY':['battery_post_and_clamp','battery_case_and_hold_down'],
  'AIR FILTER':['intake_duct_to_filter_box','element_in_engine_intake'],
  'HEADLIGHTS':['front_lamp_mount','headlamp_optics'],
  'TAILLIGHTS':['rear_corner_lamp_mount','side_combination_housing'],
  'HIGH MOUNT STOP LAMP':['rear_center_lamp_mount'],
  'OIL FILTER':['oil_filter_mount_or_element'],
  'IGNITION COIL':['coil_boot_to_plug_well'],
  'CABIN FILTER':['element_at_hvac_inlet'],
  'ENGINE COVER':['removable_top_shroud'],
  'VALVE COVER':['sealed_cylinder_head_joint'],
  'OIL PAN':['sump_flange_or_drain'],
  'ENGINE UNDERTRAY':['removable_underbody_panel'],
  'SPARK PLUG':['electrode_and_thread','socket_in_plug_well'],
  'TAILGATE TRIM':['liftgate_inner_clips_or_panel'],
  'TAILGATE HANDLE':['liftgate_release_grip']
};

export function reviewFamily(label) {
  if (label === 'OXYGEN SENSOR') return ['OXYGEN SENSOR','BRAKE PAD WEAR SENSOR'];
  if (label === 'THERMOSTAT') return ['THERMOSTAT','TURN SIGNAL BULB'];
  if (['BRAKE PAD','BRAKE CALIPER','BRAKE ROTOR'].includes(label)) return ['BRAKE PAD','BRAKE CALIPER','BRAKE ROTOR'];
  if (['BATTERY','FUSE BOX','AIR FILTER','CABIN FILTER','ENGINE COVER','VALVE COVER'].includes(label))
    return ['BATTERY','FUSE BOX','AIR FILTER','CABIN FILTER','ENGINE COVER','VALVE COVER'];
  if (['OIL PAN','ENGINE UNDERTRAY'].includes(label)) return ['OIL PAN','ENGINE UNDERTRAY','TAILGATE TRIM'];
  if (label === 'SPARK PLUG') return ['SPARK PLUG','IGNITION COIL','BATTERY'];
  if (['HEADLIGHTS','TAILLIGHTS','HIGH MOUNT STOP LAMP','OIL FILTER','IGNITION COIL','TAILGATE TRIM','TAILGATE HANDLE'].includes(label))
    return ['HEADLIGHTS','TAILLIGHTS','HIGH MOUNT STOP LAMP','OIL FILTER','IGNITION COIL','TAILGATE TRIM','TAILGATE HANDLE'];
  return [];
}

export function evidencePrompt(family) {
  if (family.includes('OXYGEN SENSOR') || family.includes('THERMOSTAT')) {
    return '沿手里的小件看工作端。刹车片磨损线末端是嵌入片边的卡头；氧传感器有旋入排气的螺纹探头和开孔护罩。琥珀色玻璃灯泡和灯座有金属触点；节温器须有水路阀盘、弹簧或能确认它装在冷却液通道。只见颜色、插头、线缆不能定类。查验原图，若确认则返回 JSON：label、cue、observation、caption。选项为' +
      JSON.stringify(Object.fromEntries(family.map(l=>[l,targetCues[l]]))) + '。若不能区分或都不符合，label 填 UNKNOWN。'+clarificationFormat;
  }
  const filter = family.includes('CABIN FILTER') ?
    '若判成空气滤芯或空调滤芯，另填 filterMount：能从滤盒追到发动机进气管为 engine_duct，可辨手套箱导轨、鼓风机或前挡风玻璃下方的新风入口为 hvac_intake。只有滤纸、黑框或没有可追踪去向的盒口为 unknown。observation 只写图中实际可见的安装参照。' : '';
  const selection = family.includes('BATTERY') ?
    '判断蓄电池或盒体时额外填写 targetSelection：手、箭头或工具确实接触该件写 contact，单独摆放写 isolated，近景突出一个物体写 detail。如果是机舱全景，可见多个大件且没有明确指向，写 ambiguous。只能看到电瓶在画面里不代表用户在问电瓶。' : '';
  const panel = family.includes('ENGINE UNDERTRAY') ?
    '区分仰拍车底和打开的尾门。另填 panelLocation，并在 observation 写出板件以外的具体参照物。可见底盘梁、发动机下侧、排气或悬架与盖板的安装关系写 chassis；能沿玻璃边、门框或尾门锁追到板件写 liftgate；只见凹槽、检修口或黑塑料写 unknown。' : '';
  const framing = family.includes('TAILLIGHTS') ?
    '若是后灯，先独立填写 landmark。只有灯体以外还能清楚看到侧车身与尾门开口的交界，填 corner_and_hatch；能看到灯与后窗或驾驶室顶边中线的关系，填 rear_window_center；其余一律填 unlocated。局部漆面、灯边黑缝、颜色、灯腔分布均不能标定左右。' : '';
  return '独立查看这一张原图。先定位正被指、握、拆装或特写的物体，再检查它自身的结构以及它连到哪里。周围零件、常见教程步骤和颜色不能替代目标证据。' +
    '刹车片要看出摩擦层贴钢背或片耳装入支架。若在拔导销、压活塞、撬弹簧或拔磨损报警线，具体小件就是目标；这些类别不在选项中时返回 UNKNOWN。移动整个带油管的钳体才支持卡钳。' +
    '电瓶正极会集成配电板，追踪工具松的是极柱夹还是熔断器。滤盒接粗进气管；单个搭扣不能证明是保险丝盒。' +
    '区分车尾中央的第三制动灯与车尾一侧组合灯，要能把灯连到原图可辨的车身位置。皮卡驾驶室顶后缘中央灯也可能带白色货厢灯。单个灯泡型号、红白灯面或插头均不能定位。' +
    '跟踪手或工具接触的边界：钻头或批头压在盘帽的固定螺钉支持制动盘，旁边钳体的活塞不能作为接触证据。' +
    '机舱宽景先分开蓄电池和旁边连进气管的滤盒。发动机装饰盖可覆盖在缸盖之上、绕开加油口；需见与缸盖密封接合的边缘才判断气门室盖。滤纸相同，要沿滤框找发动机进气道或乘员舱风道。' +
    '底部塑料护板有检修口、卡扣或与车身齐平的搭接边。油底壳须沿机体接合面或实际放油口定位。长套筒先找到工作端落在极柱、压板还是火花塞井；若被遮住且邻件不止一个就追问。' +
    '在尾门背面拆的是饰板时看板边、卡扣和背面加强筋；拉开门的把手看手握凹槽或释放机构。灯具、饰板、把手可以同框。' +
    '输出 JSON：label、cue、observation、caption。observation 写出实际接触点或取景中心和目标自身的特征，两者必须落在同一物件。caption 第一句说清具体零件及所属总成。' +
    framing+selection+panel+filter+clarificationFormat+'仅可选择有对应可见结构的 label 与 cue：'+JSON.stringify(Object.fromEntries(family.map(l=>[l,targetCues[l]])))+
    '。这些选项可能全部不符。缺乏证据或属于其他对象，label 和 cue 都填 UNKNOWN，不要想象画面外的东西。';
}

export function supportedReview(value, family, scene) {
  if (value?.label === 'AIR FILTER' && value.filterMount !== 'engine_duct') return false;
  if (value?.label === 'CABIN FILTER' && value.filterMount !== 'hvac_intake') return false;
  if (family.includes('BATTERY') && ['BATTERY','FUSE BOX','AIR FILTER'].includes(value?.label) &&
      !['contact','isolated','detail'].includes(value.targetSelection)) return false;
  if (family.includes('ENGINE UNDERTRAY') &&
      value?.panelLocation !== (value?.label === 'TAILGATE TRIM' ? 'liftgate' : 'chassis')) return false;
  if (value?.label === 'ENGINE UNDERTRAY' &&
      !/副车架|底盘梁|纵梁|横梁|排气管|悬架|悬挂|发动机底部|油底壳/.test(value.observation || '')) return false;
  if (value?.label === 'TAILLIGHTS' && value.landmark !== 'corner_and_hatch') return false;
  if (value?.label === 'HIGH MOUNT STOP LAMP' && value.landmark !== 'rear_window_center') return false;
  if (['BRAKE PAD','BRAKE CALIPER'].includes(value?.label) && scene?.expert?.labels?.includes('BRAKE PAD') &&
      scene.label !== value.label && !scene.strong && !scene.expert.preferred) return false;
  return family.includes(value?.label) && targetCues[value.label].includes(value.cue) &&
    typeof value.observation === 'string' && !!value.observation.trim() &&
    typeof value.caption === 'string' && !!value.caption.trim() && !insufficient(value.caption) &&
    !uncertainDecision({...value,kind:'part'});
}

const assemblyNames = {
  'HEADLIGHTS':['前大灯','前照灯','前灯总成'],
  'TAILLIGHTS':['侧尾灯','组合尾灯','尾灯'],
  'HIGH MOUNT STOP LAMP':['高位制动灯','第三制动灯','高位刹车灯','第三刹车灯'],
  'BRAKE PAD':['刹车片','制动片','制动衬块'],
  'BRAKE CALIPER':['制动卡钳','卡钳','制动钳','刹车钳'],
  'BRAKE ROTOR':['制动盘','刹车盘'],
  'CABIN FILTER':['空调滤芯','空调滤清器','空调滤网','座舱滤芯'],
  'AIR FILTER':['发动机空气滤清器','发动机空气滤芯','发动机进气滤'],
  'BATTERY':['蓄电池','电瓶'],
  'FUSE BOX':['保险丝盒','熔断器盒','保险盒']
};

// A close-up can establish that this is a lamp without showing its position on the car.
export function explainedRearLamp(note) {
  if (/不|没|可能|好像|似乎|大概|猜|应该|记不清|也许|[？?]|还是|或者|另外|另一个|换个|假如|如果|怎么|如何|为什么|独立.{0,4}(?:倒车灯|雾灯|转向灯)/.test(note)) return '';
  const center = rearCenter.test(note);
  const side = /车尾.{0,5}(?:一侧|两侧|左侧|右侧|左边|右边)|[左右]后(?:侧|方|角|灯)|后翼子板/.test(note);
  if (center === side) return '';
  if (center && !/保险杠|低位|下沿|旁边|附近|支架|固定件|剪线|饰板|开关/.test(note) &&
      /后窗|后挡|驾驶室后|后风挡|车顶后|扰流板|尾翼|车尾.{0,12}(?:上方|上部|偏高|高处|顶部)/.test(note) &&
      /(?:刹车|制动).{0,12}(?:亮|点亮)/.test(note))
    return '根据你补充的安装位置和亮灯时机，这是高位制动灯，装在车尾中线上，踩下刹车时亮。';
  if (side && /组合灯|组合尾灯|灯组/.test(note) && !/旁边|旁的|隔壁|附近|饰板|拉手|把手/.test(note))
    return '根据你补充的安装位置，这是车尾一侧的组合尾灯。';
  return '';
}

export const rearCenter = /中(?:心)?线|正中|中央|中间/;

export const repairTargetFormat = '沿手指、工具的工作端或箭头找实际操作对象。第一句直接报这件的具体通用名，第二句才交代所属总成和判据。拆导销、弹簧、磨损报警线或支撑卡片时就报该小件；看到卡钳不能代替识别小件。比较独立灯泡、灯座与整个灯组。允许使用类别表外的准确名称。两只手分别碰不同部件且操作指向不明时，问用户指的是哪件。';

export function expertPrompt() {
  return '你是汽修配件疑难识别的第二位读图者。独立重看首图，之后的图片只补充安装关系。逐条用用户的答复更新判断，前者、后者要结合上一问理解。判断的是首图中实际检查、展示或拆装的那一件。' +
  repairTargetFormat + identificationFormat + clarificationFormat +
  '附带的初判只是待核对的猜测。先检查实图；如果不同意，请用 observation 和 distinction 写清为什么初判对应的物件并非实际目标。看不到图片就说明，不能假设图上有任何结构。' + supplementFormat +
  '另外填写 observation（目标自身可见特征或用户明确说出的事实）、distinction（用什么事实排除了最相似的邻件）。滤芯只有证据能定位发动机进气道或座舱风道时填写 filterMount=engine_duct 或 hvac_intake；后灯只有能定位车后侧角或后窗/车尾高处中央时分别填写 landmark=corner_and_hatch 或 rear_window_center。不能定位、没有区分依据、只能列举可能性时返回 unclear。此时 question 只问一个尚未回答、车主可以观察的新事实，或具体指明补拍哪个部位以及需要同框的参照物。';
}

export function supportedExpert(value) {
  if (value?.kind !== 'part' || uncertainDecision(value) || insufficient(value.caption) ||
      ![value.observation,value.distinction].every(s=>typeof s === 'string' && s.trim().length >= 4 && !insufficient(s))) return false;
  if (value.label === 'HIGH MOUNT STOP LAMP') return value.landmark === 'rear_window_center';
  if (value.label === 'TAILLIGHTS') return value.landmark === 'corner_and_hatch';
  if (value.label === 'AIR FILTER') return value.filterMount === 'engine_duct';
  if (value.label === 'CABIN FILTER') return value.filterMount === 'hvac_intake';
  return true;
}

export function partCaption(label, caption) {
  const names = assemblyNames[label];
  const first = caption.split(/[。！？\n]/,1)[0];
  return names && !names.some(name=>first.includes(name)) ? names[0]+'。'+caption : caption;
}

export const clarificationFormat = '证据不足时另填 question。先比较最合理的几种解释，找出哪一个未知事实最能区分它们。只问一个车主能观察到的问题，用日常中文，能列举具体位置、连接处或动作时直接列举。只知道是滤芯可问从哪儿取出；若位置已知就改问滤盒接到哪里。若用户不知道，改问另一条可见线索或指定要拍哪一处。';

export const supplementFormat = '收到补图时，写 originalFeature（只描述首图中手里的小件或实际受力部位），并填 targetLink。首图对象与补图可明确对应、且结论命名的是首图对象本身时填 same_target。仅看见其安装处或整个总成填 mount_only；不能对应填 unknown。首图是一根线、插销、卡片或塑料盖，补图显示整个卡钳或发动机时，应继续识别首图小件。';

export function linkedToOriginal(value) {
  return value?.targetLink === 'same_target' && typeof value.originalFeature === 'string' && value.originalFeature.trim().length >= 4;
}

export function specificQuestion(value) {
  if (typeof value !== 'string') return '';
  const q = value.trim().split(/(?<=[？?])/u,1)[0];
  return /^(?=.{4,120}$)[^？?\n]+[？?]$/u.test(q) &&
    !/^(?:你|您)?(?:能否|能不能|能|可以|请|麻烦).{0,5}(?:提供更多信息|再拍(?:一张)?清晰(?:一点)?的?(?:图片|照片)|描述得更详细).{0,4}[？?]$/.test(q) ? q : '';
}

export function isAirFilterHint(hint) {
  return /\b(?:CABIN|AIR) FILTER\b|空气滤(?:芯|清器)|空调滤(?:芯|清器)|进气滤芯|褶(?:状|皱).*滤(?:纸|芯)/i.test(hint);
}

// Use different observable evidence when a location question has already been answered or tried.
export function choosePartQuestion(options, {evidence, notes = '', previous = []}) {
  const locationQuestion = evidence === 'lamp' ? /车头|车尾|后窗|前灯.*后灯|哪.*位置|固定在哪|装在哪/ :
    evidence === 'filter' ? /手套箱|发动机舱|从哪.*(?:拆|取)/ : null;
  const knownLocation = evidence === 'lamp' ? /车尾.{0,8}(?:中间|中央|一侧|左侧|右侧)|后窗.{0,6}(?:上沿|中央)|车头一侧/.test(notes) :
    evidence === 'filter' && /从.{0,8}(?:手套箱|发动机舱)|在发动机舱.{0,8}进气/.test(notes);
  const locationTried = locationQuestion && (knownLocation || previous.some(q=>locationQuestion.test(q)));
  const offTopic = evidence === 'lamp' ? /刹车卡钳|悬挂|排气管|底盘|进气管|保险丝/ :
    evidence === 'filter' ? /车尾灯|刹车卡钳|排气管/ : null;
  const fresh = options.find(q=>q && !previous.includes(q) && !offTopic?.test(q) &&
    !(locationTried && locationQuestion.test(q)));
  if (fresh) return fresh;
  if (evidence === 'lamp') return /踩.{0,6}(?:刹车|制动)|打转向/.test(notes) ?
    '能拍一张灯壳连同旁边车身边缘的照片，并指一下手里这件原来插在哪里吗？' :
    '踩刹车、打开车灯或打转向时，哪种操作会让这盏灯亮起来？';
  if (evidence === 'filter') return '可以拍一下放滤芯的盒子和旁边连着的管道吗？';
  return '能拍一张手指着目标、也看得到它与周围零件连接处的照片吗？';
}

export function namingOnly(value = '') {
  const text = String(value || '').trim();
  if (!text) return true;
  if (/怎么|如何|为什么|干什么|做什么|能否|多少钱|价格|故障|坏了|原因|作用|区别|翻译|写|生成|解释|建议|注意|步骤|型号|能用|适配|安全|正常|还能|维修方案|安装方法|原理|以及|并|然后|顺便/.test(text)) return false;
  const query = text.replace(/[？?！!。，,\s]+$/g,'');
  return /^(?:请|帮我|麻烦|能帮我|能不能帮我)?(?:识别|辨认|认一认|认下|认一下)(?:一下)?(?:这张图|这张照片|这个|它|一下|.{0,45}(?:汽车配件|配件|零件|部件|名称))?$/.test(query) ||
    /^(?:请问|帮我看看|看看|帮我判断一下)?(?:这|那|图中|图里|照片中).{0,30}(?:是什么|是什么东西|什么(?:汽车)?(?:配件|零件|部件)|叫什么(?:名字)?|哪(?:个|种)(?:配件|零件|部件))(?:呢|啊|呀|吗)?$/.test(query);

}

export function requestDetail(hint = '') {
  if (isAirFilterHint(hint)) return '这个滤芯是从发动机舱的进气盒里取出来的，还是从副驾驶手套箱后面取出来的？';
  if (/螺母|螺帽|螺栓|螺丝|紧固件|放油塞/.test(hint)) return '拧下手里这颗固定件后，车上哪一件会松开？';
  if (/毛毡|绒布|内衬|检修盖|电气盒盖/.test(hint)) return '打开这块盖板，里面能看到什么？';
  if (/灯|LAMP|LIGHT/.test(hint)) return '这张图还不能确定是哪一组灯。可以退后一点，把灯座、灯壳和车身位置一起拍清楚；也可以告诉我它装在车头、车尾两侧，还是后窗中央。';
  if (/刹车|卡钳|制动盘|BRAKE/.test(hint)) return '能退后一点，把手指或工具接触的那一件和它的安装位置拍在一起吗？也可以描述它贴着什么，以及你正在拆或测量哪一件。';
  if (/FUSE BOX|BATTERY|AIR FILTER|电瓶|保险丝盒|进气盒/.test(hint)) return '能把手指接触的位置和整个盒子拍在一起吗？也可以说说那一件连着粗电缆、进气管，还是能看到一排保险丝。';
  return '这张图还不能确认。可以对焦再拍一张，把目标和周围的安装位置一起拍进去；也可以直接描述它装在哪里、连着什么，或指出你想认的是哪一件。';
}

// Keep recent evidence per sender, with an overall memory bound for embedded photos.
export class PendingParts {
  entries = new Map();
  get(key) { return this.entries.get(key)?.value; }
  clear(key) {
    clearTimeout(this.entries.get(key)?.timer);
    this.entries.delete(key);
  }
  set(key, value) {
    this.clear(key);
    const bytes = value.photos.reduce((n, s) => n + s.length, 0) + value.notes.length;
    const timer = setTimeout(() => this.clear(key), 30 * 60_000);
    timer.unref();
    this.entries.set(key, {value, timer, bytes});
    let total = 0;
    for (const entry of this.entries.values()) total += entry.bytes;
    for (const [oldKey, entry] of this.entries) {
      if (this.entries.size <= 128 && total <= 64 * 1024 * 1024) break;
      total -= entry.bytes;
      this.clear(oldKey);
    }
  }
}
