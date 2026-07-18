# 流体水墨启动页：两套开源实现精读

目标：从
[PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation)
与
[topaz1008/canvas-fluid-solver](https://github.com/topaz1008/canvas-fluid-solver)
提炼适合 Peer Agent 启动页的**简化流体水墨**路径。  
范围：只做研究结论与可落地取舍，**不直接大改产品代码**。

---

## 1. WebGL-Fluid-Simulation 核心结构

### 1.1 总体

- 单文件 `script.js`（约 1600+ 行）
- GPU 全帧缓冲（FBO）多 pass 求解
- 理论来源：NVIDIA GPU Gems Ch.38 *Fast Fluid Dynamics Simulation on the GPU*
- 默认参数（节选）：

```js
SIM_RESOLUTION: 128,      // 速度/压力求解网格
DYE_RESOLUTION: 1024,     // 颜色/墨密度显示网格（可更高）
DENSITY_DISSIPATION: 1,
VELOCITY_DISSIPATION: 0.2,
PRESSURE: 0.8,
PRESSURE_ITERATIONS: 20,
CURL: 30,                 // 涡度增强，丝缕感主要来源
SPLAT_RADIUS: 0.25,
SPLAT_FORCE: 6000,
BLOOM / SUNRAYS / SHADING // 后处理，演示向
```

### 1.2 场与 FBO

| 场 | 作用 |
|----|------|
| `velocity` (DoubleFBO, RG) | 速度 |
| `dye` (DoubleFBO, RGBA) | 墨/颜色密度 |
| `divergence` | 散度 |
| `curl` | 涡度 |
| `pressure` (DoubleFBO) | 压力（迭代求解） |
| bloom / sunrays 金字塔 | 可选后处理 |

关键设计：**sim 低分辨率算物理，dye 高分辨率出画面**。

### 1.3 主循环

```text
update():
  resize / input
  if !paused: step(dt)
  render(null)   // 到屏幕
  requestAnimationFrame(update)
```

### 1.4 `step(dt)` 关键 pass（有序）

```text
1. curl          ← 由 velocity 算涡度
2. vorticity     ← 把涡度反馈回 velocity（CURL 强度）
3. divergence    ← ∇·v
4. clear pressure * PRESSURE
5. pressure × N  ← Jacobi / 迭代（PRESSURE_ITERATIONS≈20）
6. gradientSubtract ← v = v - ∇p  （不可压缩投影）
7. advection(velocity) + VELOCITY_DISSIPATION
8. advection(dye)      + DENSITY_DISSIPATION
```

### 1.5 注入：`splat(x, y, dx, dy, color)`

同一次落点写两次：

1. **velocity**：注入 `(dx, dy)` 冲量  
2. **dye**：注入颜色/墨密度  

这是“一滴墨落入水中”的正确交互模型：  
**先有速度扰动，再有墨密度**；只画圆斑没有速度场，就不会有卷曲。

### 1.6 不建议启动页照搬的部分

- Bloom / Sunrays / Shading 全套后处理  
- `DYE_RESOLUTION: 1024` + 全屏高刷交互  
- dat.gui、截图、移动端 promo  
- 高 `PRESSURE_ITERATIONS`（20）在桌面启动页过重  
- 五彩 `COLORFUL` 染料逻辑（我们要水墨单色/主题色）

---

## 2. canvas-fluid-solver 核心结构

### 2.1 总体

- `src/fluidsolver.js`：Jos Stam *Real-Time Fluid Dynamics for Games* 的 JS 实现  
- `src/main.js`：Canvas 2D 渲染 + 鼠标注入  
- CPU 网格，Navier–Stokes 不可压缩简化求解  

默认：

```js
NUM_OF_CELLS = 128          // N×N 内部格点（+2 边界）
dt = 0.23
diffusion = 0.0004
viscosity = 0
iterations = 15             // Gauss-Seidel
doVorticityConfinement = true
doBuoyancy = true
```

### 2.2 网格 / 数组

每个量各两套缓冲（当前 / 上一步）：

```text
u, v, d          // 当前速度 x/y、密度
uOld, vOld, dOld // 源项与交换缓冲
curlData
numOfCells = (N+2)*(N+2)
I(i,j) = i + (N+2)*j
```

### 2.3 步进

**velocityStep()**

```text
addSource(u,uOld); addSource(v,vOld)
optional vorticityConfinement → 再 addSource
optional buoyancy → 只加到 v
diffuse(u), diffuse(v)
project(u,v)                 // 第 1 次投影
advect(u), advect(v)
project(u,v)                 // 第 2 次投影
清零 uOld/vOld
```

**densityStep()**

```text
addSource(d, dOld)
diffuse(d)
advect(d)  // 用当前 u,v 运移密度
清零 dOld
```

底层公共件：`#diffuse` / `#advect` / `#project` / `#linearSolve` / `#set_bnd`。

### 2.4 主循环（main.js）

```text
update():
  fs.velocityStep()
  fs.densityStep()
  把 d[] 填进 offscreen ImageData（按 cell 放大到像素）
  putImageData
  可选画速度线 / 粒子
  requestAnimationFrame(update)
```

鼠标注入：

```text
uOld[I(i,j)] = du   // 指针速度
dOld[I(i,j)] = 150  // 按住时加密度
```

同样是 **速度 + 密度双注入**。

### 2.5 性能特征

- N=128 时约 130×130 格，每步多次 `linearSolve`（iterations=15）  
- CPU 上可交互，但启动页若全屏高刷会吃主线程  
- 渲染是 cell→像素块，偏“格子感”，要柔需要额外 blur/升采样  

---

## 3. 两套方案对比

| 维度 | WebGL Fluid | Canvas Fluid Solver |
|------|-------------|---------------------|
| 算力 | GPU FBO pass | CPU 数组 |
| 视觉上限 | 很高（丝缕、卷曲、高 dye 分辨率） | 中等（网格感明显） |
| 代码体量 | 大、WebGL/扩展依赖多 | 小、逻辑清晰 |
| 与主题色集成 | dye 着色可做，但管线重 | ImageData 直接染墨色最简单 |
| 启动页风险 | 初始化慢、上下文丢失、包体/复杂度 | 主线程卡顿、分辨率一高就掉帧 |
| 算法骨架 | 同一家族：advect + project + 涡度 | 同一家族：Stam stable fluids |

**共同点（水墨真正需要的）：**

1. 速度场 + 密度场  
2. 落墨 = splat 速度冲量 + splat 密度  
3. advection 让墨跟着流走  
4. project / pressure 让流动“像水”而不是粒子乱飞  
5. vorticity confinement 提供卷曲丝缕  

**我们之前失败的根因：**  
只有“看起来像烟的粒子/圆团”，**没有密度被速度场 advect**，所以像虫子或脏点。

---

## 4. 启动页可落地简化路径（推荐）

### 4.1 目标体验

- 3.2s 品牌入场：字标黑/定调，背景干净  
- 入场结束后仍在 bootstrap：  
  **随机一滴墨落下 → 带一点初速度/涡旋 → 在水中卷曲散开并缓慢消散**  
- 浅色主题：深墨；深色主题：浅墨/冷灰白  
- 字标层始终压在流体之上，不参与流体变形  

### 4.2 推荐技术选型（启动页）

**第一推荐：轻量 WebGL 2 或 WebGL1 最小流体（从 Pavel 裁剪）**

只保留：

```text
modules:
  - DoubleFBO(velocity @ 64~96)
  - DoubleFBO(dye @ 256~512)
  - FBO(divergence, curl)
  - DoubleFBO(pressure)
  - programs: curl, vorticity, divergence, clear, pressure, gradientSubtract, advection, splat, display
```

砍掉：bloom、sunrays、shading、gui、screenshot、colorful 循环。

参数建议（启动页）：

```text
SIM_RESOLUTION: 64~96
DYE_RESOLUTION: 256~512
PRESSURE_ITERATIONS: 8~12
CURL: 15~25
DENSITY_DISSIPATION: 偏高一点（墨要淡出，别永久糊屏）
VELOCITY_DISSIPATION: 中等
SPLAT: 间歇随机 1 滴，带小径向/切向 force
```

**备选：Canvas CPU Stam solver（从 topaz 裁剪）**

适合“先验证手感 / 无 WebGL 降级”：

```text
N = 48~64
iterations = 6~10
viscosity ≈ 0
diffusion 很小
doVorticityConfinement = true
doBuoyancy = 可选（墨略上浮）
渲染: Float32 密度 → 主题色 alpha ImageData，再轻微 blur
```

N>80 且每帧全量写 ImageData 时，启动页容易抢主线程，需限帧（30fps）或缩小画布再 CSS 放大。

### 4.3 最小模块划分（产品内）

```text
BrandStartupLoader
  ├─ BrandMark (SVG, 静态)
  └─ FluidInkBackdrop
       ├─ createFluidContext (webgl | canvas-fallback)
       ├─ fluidStep(dt)
       ├─ splatInk({x,y,dx,dy,amount,color})
       ├─ display()
       └─ themeInkColor(data-theme)
```

契约要点：

- `introFinished` 后才 `startIdleDrops()`  
- bootstrap 结束 unmount 时 `dispose()` 释放 GL/RAF  
- `prefers-reduced-motion`: 不跑 solver，静态极淡墨渍或纯色  

### 4.4 一滴墨的时序（可执行）

```text
every 1.2~2.8s (随机):
  pick (x,y) in soft center band
  pick small velocity (dx,dy) or circular swirl
  splat velocity (force)
  splat dye (ink color, radius small→medium)
  optional second micro-splat offset 4~10px（破圆对称）
```

不要：

- 每帧大量粒子 stamp  
- 只有 radial gradient 无 velocity  
- 五彩 dye（除非以后单独做演示模式）

### 4.5 主题色

| 主题 | dye / density 颜色 |
|------|----------------------|
| light | `rgba(18,20,26, α)` 深墨 |
| dark | `rgba(210,220,235, α)` 冷白墨 |

display pass 用预乘 alpha 叠在启动页背景上，避免黑底方块。

---

## 5. 明确不建议照搬

1. **整仓复制 PavelDoGreat**  
   后处理、GUI、高分辨率、移动端 promo 全是噪音。  
2. **把 topaz 的 128 网格 + 速度线 + 粒子调试层直接塞进启动页**  
   会像科学演示，不像品牌水墨。  
3. **继续用“多粒子丝缕 / 软圆 puff”冒充流体**  
   缺 project+advect，形态上永远假。  
4. **启动页主线程跑 N≥128 的 CPU solver 且 60fps**  
   与应用 bootstrap 抢资源。  
5. **墨色五彩 / bloom 光污染**  
   与 Peer Agent 黑白品牌冲突。

---

## 6. 分阶段落地建议

| 阶段 | 做什么 | 验收 |
|------|--------|------|
| A. 预览原型 | 独立 html，最小 WebGL 或 CPU solver，只 splat 深墨 | 肉眼：一滴落下有卷曲，不是圆或虫子 |
| B. 主题与节奏 | light/dark、间歇落墨、dissipation 调到 2–4s 淡出 | 不糊屏、不抢眼压过字标 |
| C. 接入 BrandStartupLoader | intro 后挂载，bootstrap 完销毁 | 无 GL 泄漏；reduced-motion 静默 |
| D. 降级 | WebGL 失败 → CPU N=48 或静态墨 | 启动永不白屏 |

### A 阶段原型（已完成，独立预览）

路径：

- `docs/design/fluid-ink-drop-prototype.html`

用法：

```bash
# 在 docs/design 目录起本地服务后打开
python3 -m http.server 8765 --directory docs/design
# 浏览器访问
open http://127.0.0.1:8765/fluid-ink-drop-prototype.html
```

也可用任意静态服务器直接打开该 HTML。

原型要点（对照本文建议）：

- CPU Stam 简化求解：`velocityStep`（diffuse → **project** → **advect** → **project**）+ `densityStep`（diffuse → **advect**）
- 落墨 `splat` **双写**：速度冲量 `u/v` + 密度 `d`
- 间歇随机一滴 + 次级 micro-splat 破圆对称
- 主题：light 深墨 / dark 冷白墨
- **未接入** `BrandStartupLoader`，仅供肉眼验收流体卷曲感

当前仓库状态：A 阶段独立原型已挂上；产品启动页仍是旧 canvas 尝试。**下一步 B/C 再谈主题节奏与接入**，不要回退到 puff/粒子假流体。

---

## 7. 一句话结论

- **效果上限学 Pavel 的 GPU pass 顺序与 splat 双写。**  
- **算法可读性学 topaz 的 Stam 网格步进。**  
- **启动页落地：裁剪后的低分辨率稳定流体 + 主题单色 dye + 间歇落墨；不要后处理大礼包，也不要假粒子。**

---

## 参考

- GPU Gems 38: Fast Fluid Dynamics Simulation on the GPU  
- Jos Stam: Real-Time Fluid Dynamics for Games (GDC03)  
- https://github.com/PavelDoGreat/WebGL-Fluid-Simulation (`script.js`)  
- https://github.com/topaz1008/canvas-fluid-solver (`src/fluidsolver.js`, `src/main.js`)
