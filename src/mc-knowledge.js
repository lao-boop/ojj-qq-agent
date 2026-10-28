/** 给模型补的 Minecraft 常识：她不知道这些就会显得“呆呆的”。 */
export const MC_KNOWLEDGE = `【Minecraft 常识（生存模式）】
- 开局先弄木头：徒手打树 → 原木 → 木板 → 木棍 → 工作台 → 木镐。
- 石头/矿石必须用镐：木镐能挖石头和煤，石镐才能挖铁，铁镐才能挖钻石；空手挖石头几乎挖不动。
- 挖到的原木要合成木板才能用；木板 4 个 → 工作台 1 个；木板 2 个竖着 → 木棍 4 个。
- 工作台要放在地上才能用（右键打开）；熔炉要燃料（煤/木炭/木头）+ 矿石才能烧。
- 白天 10 分钟、夜晚 7 分钟；夜里会刷僵尸/骷髅/蜘蛛/苦力怕，没有武器和床就很危险。
- 饥饿值低于 18 不能回血；饿了要吃东西（面包/熟肉/苹果）。
- 床要放在地上，夜里右键才能睡；睡醒会跳过夜晚并设置重生点。
- 坐标 (x,y,z)：y 是高度，海平面约 63；往下挖要小心脚底岩浆和掉落。
- 主世界之外还有下界/末地，需要传送门；现在不用管。
- 死了会掉身上东西并回到重生点。
- 圆石（cobblestone）是挖石头掉的，不是石头本身。`;

/** 当前游戏状态，用一句话描述，塞进上下文。 */
export function mcStatusText(snap) {
  if (!snap) return '';
  const t = Number(snap.timeOfDay ?? 0);
  const phase = t < 12000 ? '白天' : t < 13000 ? '黄昏' : '夜晚';
  const inv = (snap.inventory || []).slice(0, 8).join('、') || '空';
  return `【你现在的状态】坐标 ${snap.position.x},${snap.position.y},${snap.position.z}｜血 ${snap.health}｜饥饿 ${snap.food}｜${phase}｜手持 ${snap.heldItem}｜背包：${inv}${snap.nearbyHostiles ? `｜附近有 ${snap.nearbyHostiles} 只怪` : ''}`;
}
