# 竞品与 TTS 调研 (2026-11-17)

完整报告如下，按你要求的五部分排列。
价格大多来自第三方，各平台定价页没全部打开核实，标"?"的是推断，或来源之间有冲突。

## 1. ebook2audiobook (E2A)
- **基本情况**：2.06万星，当前版本 v26.11.16，2026-11-16 还在提交。项目代码是 Apache-2.0，可以商用和做 SaaS（查自 GitHub API）。
- **输入格式**：EPUB、MOBI、AZW3、FB2、PDF、TXT、DOCX、HTML、ODT 等，图片走 OCR。底层先调 Calibre 的 `ebook-convert` 统一转成 EPUB。Calibre 是 GPL-3，作为子进程调用一般没问题。
- **章节切分**：没有真正的章节识别，按 EPUB 内部的 spine 文档切块，源码注释原话是 "CHAPTER does not mean real chapter"。EPUB、MOBI 效果最好，PDF 很差。
- **句子切分**：用 stanza NLP 分词、识别日期等实体，再按标点用正则切，按语言设 `max_chars` 上限。数字用 num2words 转成单词，脚注会被过滤。
- **TTS 引擎**：`conf_models.py` 里列了约 50 个。默认是 XTTSv2，另有 Bark、Tortoise、VITS、Fairseq、Piper、Kokoro、F5、Chatterbox、Zonos、Orpheus、CosyVoice3、Qwen3-TTS、VibeVoice、IndexTTS2 等。
- **声音克隆**：支持，传 1 到 5 分钟参考音频即可（XTTS、F5 等）。还有一个变声功能，能把 Piper 这类内置音色转成参考音色。
- **硬件**：最低 2GB 内存加 1GB 显存，推荐 8GB 加 4GB。支持 CUDA、ROCm、MPS、XPU、Jetson。README 原话："Modern TTS engines are very slow on CPU"。
- **转换速度**：官方没给基准。我按第三方的 XTTS 实时率估算（未核实）：一本约 11 小时音频的书，GPU 约 1 到 4 小时，CPU 可能要十几到几十小时。Kokoro 在 T4 GPU 上约 5 分钟一本，M2 CPU 约 1 小时。
- **输出**：默认 M4B，用 ffmetadata 写入 `[CHAPTER]` 章节标记。也支持 mp3、flac、ogg 等格式。
- **时间轴**：会额外输出句子级 `.vtt` 字幕。时间是按每句音频的时长累加算出来的，**没有词级时间**。
- **默认模型许可（关键风险）**：
  - XTTSv2 的权重是 CPML，**输出音频也不能商用**。Coqui 已于 2023 年底到 2024 年初倒闭，商用授权买不到了（[HF 模型卡](https://huggingface.co/coqui/XTTS-v2)）。
  - Piper：新仓库 piper1-gpl 是 GPL-3，旧的 rhasspy/piper 是 MIT。各音色的许可要逐个核对，不少是 NC（非商用），例如 lessac 只能用于研究。
  - Bark 是 MIT。Kokoro-82M 的权重是 **Apache-2.0**，但依赖的 espeak-ng 是 GPL-3。
- **结论**：别直接拿 E2A 做服务。可以借鉴它的 EPUB 清洗、句子切分和 M4B 拼接思路，TTS 换成 Kokoro 或云厂商。

## 2. 竞品核心流程
- **ElevenReader**
  - 上传：PDF、无 DRM 的 EPUB、DOCX、网页链接，可拍照扫描。
  - 同步：逐词高亮。
  - 收费：Ultra 约 $11/月或 $99/年，额度说法有冲突，官方写"无限"，第三方说每月 20 小时。
  - 生成方式：点播放几秒就出声，应该是边播边流式生成（推断）。没有学习功能。
- **Speechify**
  - 上传：EPUB、PDF，可拍照，不支持 DRM 文件。
  - 同步：逐词高亮。AI 功能有摘要和对话，倍速最高 5x。
  - 收费：约 $139/年或 $29/月，据说有每月 15 万词的隐藏上限。
- **NaturalReader / Voice Dream**：纯朗读工具，订阅制。NaturalReader Plus 约 $10/月；Voice Dream 被收购后改订阅，口碑下滑。没有学习功能。
- **Readwise Reader**
  - TTS 跟读高亮，滚动后有"返回播放位置"按钮。
  - 耳机手势：三击就能**高亮当前句**，这是"只听不看时捕捉内容"的最佳先例（[docs](https://docs.readwise.io/reader/docs/faqs/text-to-speech)）。
  - Ghostreader 提供 AI 查词、摘要、问答。
- **LingQ**
  - 导入：电子书、网页、音频都行，音频用 Whisper 转写，自带 TTS。
  - 词汇状态：蓝色是新词，黄色是学习中（1 到 4 级），白色是已认识，翻页时没点的词自动标为已认识。黄色词再生成 SRS 卡片。
  - 收费：约 $9 到 13/月，免费版只能存 20 个词。
- **Readlang**：点词翻译，存的词进闪卡做 SRS 复习，网页和导入文本都能用。
- **Language Reactor**：视频双语字幕，点词查词典后存词，支持导出 Anki（带音频和截图），有句子挖掘功能 PhrasePump。Pro 约 $5/月，只有桌面版。
- **Beelinguapp**：双语对照阅读，配真人朗读音频，同步高亮。内容由官方提供，不能上传。
- **Kindle Read & Listen（原 Whispersync）/ Immersion Reading**：电子书和 Audible 有声书都要买，靠真人朗读加逐词对齐实现高亮，可在读和听之间无缝切换位置。只覆盖部分书和地区。
- **Apple Books**：可以导入 EPUB，查词靠系统词典，有给出版社用的 AI 朗读有声书。没有生词本和 SRS。

## 3. 值得照搬的模式
- **按需分段生成，不预渲染整本**：以句子或段落为单位，在播放位置前保持 5 到 10 分钟的缓冲，生成后缓存，后台慢慢补齐全书。首次播放能做到小于 3 秒，成本按实际收听计。
- **稳定的句子 ID**：每句话有固定 ID，同时对应文本位置（类似 EPUB CFI）和音频时间。高亮、书签、生词卡、AI 提问都挂在这个 ID 上。
- **跟读同步高亮**：词级用 TTS 引擎返回的时间戳，退而求其次用句级。滚动后暂停跟随，提供"回到播放处"按钮。
- **纯听模式下的捕捉**：
  - 锁屏、耳机按钮或大按钮"收藏刚才那句"，存当前句和上一句，事后再整理。
  - 回退 10 到 15 秒、上一句、单句循环。
- **播放基础件**：后台播放、锁屏控件、章节列表、倍速 0.5 到 3x、睡眠定时（含"播完本章停"）、记住进度、离线下载。
- **学习层**：
  - 词汇状态照搬 LingQ 的颜色分级。
  - 点词弹出中文释义、音标、例句，加入 SRS（FSRS 算法），可导出 Anki。
  - 卡片附原句和原句音频片段，这是独有优势。
- **AI**：用中文解释这句话（语法、短语、文化背景），并支持针对选中内容追问。

## 4. TTS 成本（10 万词约 58 万字符，约 11 小时音频）

| 方案 | 单价 | 每本成本 | 词级时间戳 |
|---|---|---|---|
| OpenAI gpt-4o-mini-tts | 约 $0.015/分钟 | 约 $10 | ❌ 需自己做强制对齐（WhisperX 等） |
| ElevenLabs Flash / Multilingual v2 | $0.05 / $0.10 每千字符 | 约 $29 / $58 | ✅ `/with-timestamps` 接口，字符级 |
| Azure Neural / HD | 约 $15 / $30+ 每百万字符 | 约 $9 / $18+ | ✅ WordBoundary 事件，词和句边界都有 |
| Google Chirp 3 HD / Neural2 | $30 / $16 每百万字符 | 约 $17 / $9 | ⚠️ 只能在 SSML 里插 `<mark>` 取时间点，Chirp 3 HD 似乎不支持 `<mark>`? |
| Kokoro 自部署 | 只算 GPU 费用 | 低于 $0.1（T4 约 5 分钟一本?） | ✅ Kokoro-FastAPI 的 `captioned_speech` 接口，词级 |

- 每月免费额度：Azure 50 万字符，Google Chirp 3 HD 100 万字符。
- **MVP 建议**：Kokoro 自部署作为默认音色（便宜、Apache-2.0、自带词级时间），Azure HD 或 ElevenLabs 作为付费的"高级音色"。

## 5. 版权与法律
- **只接受无 DRM 的文件，绝不破解 DRM**。美国 DMCA §1201 禁止绕过技术保护措施，中国著作权法也有类似规定。现实问题是大部分 Kindle 书都带 DRM，用户从 Kindle 买的书大多传不上来，这是获客漏斗上的硬伤。
- **用户上传、自己听，属于私人复制**，风险相对低，但"格式转换"是否算合理使用并没有明确结论。
- **生成的音频不能跨用户共享**，即使是同一本书、按文件哈希复用缓存也不行，否则就构成传播，侵犯信息网络传播权。
- **用户协议**：写明用户保证自己有权使用上传内容，并建立 DMCA 侵权通知和下架流程。
- **可以放心共享的内容**：Project Gutenberg、Standard Ebooks 这类公有领域的书，能做内置书库，音频可以全站共享缓存。
- **面向中国大陆运营**：还要做 ICP 备案和生成式 AI 备案，并按《人工智能生成合成内容标识办法》（2025-09 起施行?）给 AI 音频加标识。上线前建议找律师确认。

主要来源：E2A 源码（`lib/conf_models.py`、`lib/core.py`、`tts_engines/common/utils.py`），Kokoro 的 HF 模型卡，Readwise 和 Audible 帮助文档，Google TTS 的 v1beta1 文档和发布说明，各厂商定价页。