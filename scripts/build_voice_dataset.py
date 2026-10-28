"""生成晓伊（zh-CN-XiaoyiNeural）的 RVC 训练素材。

用法：
  python scripts/build_voice_dataset.py <out_dir> [name]

产出：
  <out_dir>/dataset/<name>/split_0001.wav ...
  <out_dir>/<name>.zip   （可直接传给 replicate/train-rvc-model 的 dataset_zip）
"""
import asyncio
import os
import shutil
import subprocess
import sys
import zipfile

import edge_tts

VOICE = "zh-CN-XiaoyiNeural"
FFMPEG = os.environ.get("FFMPEG_PATH") or shutil.which("ffmpeg") or "ffmpeg"

# 覆盖尽量多的音素/语气：陈述、疑问、感叹、数字、人名、情绪、日常、书面、歌词感
TEXTS = [
    "今天天气还不错，就是风有点大。",
    "你吃饭了吗？我刚点了外卖。",
    "这个周末你有什么安排吗？",
    "我昨天看了一部特别好看的电影。",
    "帮我看看这个价格是不是有点贵。",
    "早上好呀，今天也要加油哦。",
    "晚上早点睡，别又熬夜了。",
    "这件衣服的颜色我挺喜欢的。",
    "你觉得我们应该先做哪一步？",
    "我在地铁上，信号不太好。",
    "窗外的雨下了一整个下午。",
    "楼下那家面馆的味道真不错。",
    "小鲸鱼从深海里浮上来换了口气。",
    "海风把她的头发吹得乱七八糟。",
    "他一边笑一边把伞递给我。",
    "这个问题我想了很久也没想明白。",
    "你能再说一遍吗？刚才没听清。",
    "别着急，慢慢来，还有时间。",
    "第一批货大概星期三能到。",
    "麻烦把发票抬头改成公司名称。",
    "这个型号有两个规格，你要哪一个？",
    "库存还剩三件，要的话尽快下单。",
    "我们这边支持七天无理由退换。",
    "运费是满一百包邮，不满收八块。",
    "你稍等，我查一下最新的报价。",
    "这款卖得最好，回头客特别多。",
    "如果需要定制，周期大概是两周。",
    "我先给你报个大概的价格区间。",
    "好的，那就按你说的办。",
    "嗯，我知道了，谢谢你。",
    "真的吗？我有点不敢相信。",
    "哎呀，怎么又下雨了。",
    "太棒了，这次总算赶上了。",
    "别难过，事情总会好起来的。",
    "我有点困了，先眯一会儿。",
    "你笑起来的样子特别好看。",
    "好久不见，你最近过得怎么样？",
    "记得多喝水，别老喝冰的。",
    "路上小心，到了给我发个消息。",
    "生日快乐，愿你天天开心。",
    "新年好，祝你万事顺意。",
    "一二三四五六七八九十。",
    "今天是二零二六年十月二十三日。",
    "价格是三千五百八十元整。",
    "请联系张先生，电话是幺三八开头。",
    "我希望明天是个大晴天。",
    "月亮升起来的时候，海面亮晶晶的。",
    "她把贝壳贴在耳边，听见了浪声。",
    "远处的灯塔一闪一闪，像在眨眼。",
    "我们坐在礁石上，谁都没有说话。",
    "潮水退去以后，沙滩上留下很多小洞。",
    "故事要从很久很久以前说起。",
    "他推开门，屋子里一股旧书的味道。",
    "请你把这段话读给旁边的人听。",
    "这个方案还有几个细节需要确认。",
    "我们下周一上午十点开个短会。",
    "你先按这个版本改一版给我看看。",
    "好的，收到，我马上处理。",
    "抱歉，刚才在忙，没看到消息。",
    "没关系，不用放在心上。",
    "要不我们换个时间再聊？",
    "你说的这个想法挺有意思的。",
    "我倒是觉得可以先试一试。",
    "这件事交给我，你放心。",
    "再给我五分钟，马上就好。",
    "冰箱里还有半个西瓜。",
    "咖啡凉了，我再去热一杯。",
    "猫又趴在键盘上不肯下来。",
    "阳台上的绿萝长出新叶子了。",
    "洗衣机响了，我去晾衣服。",
    "快递放在门口，记得拿进来。",
    "这首歌的旋律一直在脑子里转。",
    "她轻轻哼着调子，慢慢睡着了。",
    "海鸥叫了一声，掠过水面飞远了。",
    "我把窗户关上，屋里一下子安静了。",
    "你还记得我们第一次见面的地方吗？",
    "时间过得真快，一转眼就一年了。",
    "以后有机会，我们再去一次。",
    "那就这么说定了，不许反悔。",
    "哈哈，你也太逗了吧。",
    "唔，让我想想怎么跟你说。",
    "别闹了，我这儿正忙着呢。",
    "你先别急，听我把话说完。",
    "说到底，还是得靠自己。",
    "生活嘛，总有点小麻烦。",
]

PROSODY = [
    ("+0%", "+0Hz"),
    ("+8%", "+3Hz"),
    ("-6%", "-2Hz"),
]


async def synth_one(text, rate, pitch, mp3_path, sem):
    async with sem:
        for attempt in range(3):
            try:
                com = edge_tts.Communicate(text, VOICE, rate=rate, pitch=pitch)
                await com.save(mp3_path)
                if os.path.exists(mp3_path) and os.path.getsize(mp3_path) > 2000:
                    return True
            except Exception as e:
                print("  retry", attempt + 1, e)
        return False


async def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "data/voice-dataset"
    name = sys.argv[2] if len(sys.argv) > 2 else "xiaoyi"
    tmp = os.path.join(out_dir, "_tmp")
    wav_dir = os.path.join(out_dir, "dataset", name)
    os.makedirs(tmp, exist_ok=True)
    os.makedirs(wav_dir, exist_ok=True)

    sem = asyncio.Semaphore(4)
    jobs = []
    idx = 0
    for text in TEXTS:
        for rate, pitch in PROSODY:
            idx += 1
            jobs.append((idx, text, rate, pitch))
    print(f"共 {len(jobs)} 条待合成")

    async def worker(item):
        i, text, rate, pitch = item
        mp3 = os.path.join(tmp, f"t{i:04d}.mp3")
        ok = await synth_one(text, rate, pitch, mp3, sem)
        return (i, mp3 if ok else None)

    results = await asyncio.gather(*[worker(j) for j in jobs])

    made = 0
    total_sec = 0.0
    for i, mp3 in results:
        if not mp3:
            continue
        wav = os.path.join(wav_dir, f"split_{i:04d}.wav")
        proc = subprocess.run(
            [FFMPEG, "-y", "-loglevel", "error", "-i", mp3, "-ar", "48000", "-ac", "1", wav],
            capture_output=True,
        )
        if proc.returncode == 0 and os.path.exists(wav):
            made += 1
            total_sec += os.path.getsize(wav) / (48000 * 2)
        os.remove(mp3)

    shutil.rmtree(tmp, ignore_errors=True)

    zip_path = os.path.join(out_dir, f"{name}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_STORED) as z:
        for f in sorted(os.listdir(wav_dir)):
            z.write(os.path.join(wav_dir, f), f"dataset/{name}/{f}")

    print(f"完成：{made} 段，总时长约 {total_sec/60:.1f} 分钟")
    print(f"zip: {zip_path} ({os.path.getsize(zip_path)/1024/1024:.1f} MB)")


if __name__ == "__main__":
    asyncio.run(main())
