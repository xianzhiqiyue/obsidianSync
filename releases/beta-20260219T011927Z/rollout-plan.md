# beta-20260219T011927Z 灰度放量计划

## 波次与目标
- wave1：3 名内部用户，验证基础可用性与 P0/P1 风险。
- wave2：10 名高频用户，验证稳定性与性能。
- wave3：全部 Beta 用户，观察一周稳定性。

## 放量门禁
- 指标检查通过（scripts/check-metrics.sh）。
- 未关闭 P0/P1 = 0。
- 最小反馈量达到要求（可通过 MIN_FEEDBACK_COUNT 控制）。
- 最小反馈用户数达到要求（可通过 MIN_UNIQUE_REPORTERS 控制）。

## 建议门槛
- wave1 -> wave2：MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3
- wave2 -> wave3：MIN_FEEDBACK_COUNT=10 MIN_UNIQUE_REPORTERS=8

## 执行命令示例
- RELEASE_TAG=beta-20260219T011927Z WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/check-wave-gate.sh
- RELEASE_TAG=beta-20260219T011927Z WAVE=wave2 MIN_FEEDBACK_COUNT=10 MIN_UNIQUE_REPORTERS=8 scripts/check-wave-gate.sh
- RELEASE_TAG=beta-20260219T011927Z WAVE=wave1 MIN_FEEDBACK_COUNT=3 MIN_UNIQUE_REPORTERS=3 scripts/advance-beta-wave.sh
