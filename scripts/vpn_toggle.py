#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
scripts/vpn_toggle.py
===========================================================================
操作桌面 Mihomo Party，点击左上角「系统代理」的开启按钮（灰色=关，蓝色=开）。

autoclaw 跑谷歌任务时，浏览器是用 --proxy-server=127.0.0.1:7890 显式走 Clash
的 mixed 端口。本脚本负责把 Mihomo Party 的「系统代理」开关点亮——内核已在跑
的前提下，7890 才会监听，谷歌流程才出得去。

用法:
  python vpn_toggle.py            # 默认：确保系统代理开启（已开则不动）
  python vpn_toggle.py --on       # 同上，显式
  python vpn_toggle.py --off      # 关闭系统代理
  python vpn_toggle.py --status   # 仅打印 7890 状态后退出
  python vpn_toggle.py --click-only  # 不判断状态直接点一下（兜底）
  python vpn_toggle.py --debug    # 打印窗口/控件树，便于排查控件名

依赖: pip install uiautomation
运行环境: 必须在有桌面的【交互会话】里运行（不能在无显示的服务/沙箱里跑）。

判据: “是否已开”的客观标准是 TCP 连一下 127.0.0.1:7890——能连=已开，连不上=没开
（或 Mihomo 内核根本没启动，那时仅点亮系统代理也不够，会提示你先起内核）。
"""
import argparse
import socket
import sys
import time

PROXY_PORT = 7890

# Mihomo Party 窗口标题关键字（用于定位窗口）
MIHOMO_TITLE_HINTS = ["Mihomo Party", "mihomo", "Clash Verge", "Clash"]

# 「系统代理」控件名称候选（不同版本文案可能略有差异，依次尝试）
PROXY_LABEL_NAMES = ["系统代理", "系统代理:", "System Proxy", "系统代理开关"]

# ---- 坐标兜底 ----
# 若按名称找不到控件（Electron 常见），设 USE_COORDS=True 并填写你机器上
# 「系统代理」开关的中心像素坐标（用截图+画图量，或先 --debug 看窗口位置）。
USE_COORDS = False
TOGGLE_X = 0
TOGGLE_Y = 0


def is_port_listening(port=PROXY_PORT, host="127.0.0.1", timeout=1.0):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(timeout)
    try:
        return s.connect_ex((host, port)) == 0
    finally:
        s.close()


def import_uiautomation():
    try:
        import uiautomation as auto
        return auto
    except ImportError:
        sys.stderr.write("缺少依赖 uiautomation，请先安装: pip install uiautomation\n")
        return None


def find_mihomo_window(auto):
    for hint in MIHOMO_TITLE_HINTS:
        for w in auto.GetRootControl().GetChildren():
            name = w.Name or ""
            if hint.lower() in name.lower() and w.ControlType == auto.ControlType.WindowControl:
                return w
    return None


def walk(control, depth=0, max_depth=12):
    """递归遍历控件树，产出所有后代控件。"""
    if depth > max_depth:
        return
    for child in control.GetChildren():
        yield child
        yield from walk(child, depth + 1, max_depth)


def find_proxy_toggle(auto, window):
    # 方法1：直接按名称找「系统代理」控件（标签或开关本身）
    for name in PROXY_LABEL_NAMES:
        ctrl = window.Control(searchDepth=10, Name=name)
        if ctrl.Exists(0):
            return ctrl
    # 方法2：递归找名称含“代理”或“系统”的按钮/开关
    for ctrl in walk(window):
        n = ctrl.Name or ""
        if ("代理" in n or "系统代理" in n) and (
            ctrl.ControlType == auto.ControlType.ButtonControl
            or ctrl.ControlType == auto.ControlType.CheckBoxControl
        ):
            return ctrl
    return None


def center_of(ctrl):
    rect = ctrl.BoundingRectangle
    return rect.left + rect.width() // 2, rect.top + rect.height() // 2


def click_control(auto, ctrl):
    x, y = center_of(ctrl)
    auto.Click(x, y)
    return x, y


def main():
    ap = argparse.ArgumentParser(description="切换 Mihomo Party 系统代理")
    ap.add_argument("--off", action="store_true", help="关闭系统代理")
    ap.add_argument("--status", action="store_true", help="仅打印状态")
    ap.add_argument("--click-only", action="store_true", help="不判断状态直接点一下（兜底）")
    ap.add_argument("--debug", action="store_true", help="打印窗口/控件调试信息")
    args = ap.parse_args()
    target = "off" if args.off else "on"

    auto = import_uiautomation()
    if auto is None:
        sys.exit(2)

    win = find_mihomo_window(auto)
    if not win:
        sys.stderr.write("未找到 Mihomo Party 窗口，请确认软件已启动并可见。\n")
        sys.exit(3)

    win.SetActive()
    time.sleep(0.3)

    if args.debug:
        print("窗口:", win.Name, "| 位置:", win.BoundingRectangle)
        print("控件树（前 40 个可点击项）:")
        cnt = 0
        for ctrl in walk(win):
            n = ctrl.Name or ""
            if n and ctrl.ControlType in (
                auto.ControlType.ButtonControl,
                auto.ControlType.CheckBoxControl,
                auto.ControlType.TextControl,
            ):
                r = ctrl.BoundingRectangle
                print("  - [%s] %r @ (%d,%d)" % (ctrl.ControlType, n, r.left, r.top))
                cnt += 1
                if cnt >= 40:
                    break

    currently_on = is_port_listening()
    print("当前 7890 端口(%d): %s" % (PROXY_PORT, "监听(已开)" if currently_on else "未监听(关闭/内核未起)"))

    if args.status:
        sys.exit(0)

    if args.click_only:
        toggle = find_proxy_toggle(auto, win)
        if not toggle:
            sys.stderr.write("未找到「系统代理」开关控件。可运行 --debug 查控件名，或设脚本顶部 USE_COORDS/TOGGLE_X/Y。\n")
            sys.exit(4)
        x, y = click_control(auto, toggle)
        print("已直接点击开关中心 (%d,%d)" % (x, y))
        time.sleep(1.5)
        print("点击后 7890:", "监听" if is_port_listening() else "仍未监听")
        sys.exit(0)

    # 已是目标状态则不动
    if (target == "on" and currently_on) or (target == "off" and not currently_on):
        print("已处于目标状态，无需操作。")
        sys.exit(0)

    toggle = find_proxy_toggle(auto, win)
    if not toggle:
        if USE_COORDS and TOGGLE_X and TOGGLE_Y:
            auto.Click(TOGGLE_X, TOGGLE_Y)
            print("已用坐标兜底点击 (%d,%d)" % (TOGGLE_X, TOGGLE_Y))
        else:
            sys.stderr.write(
                "未找到「系统代理」开关控件，且未配置坐标兜底。\n"
                "请：1) 确认 Mihomo 版本；2) 运行 `python vpn_toggle.py --debug` 看控件名；\n"
                "3) 或在脚本顶部设 USE_COORDS=True + TOGGLE_X/Y 用坐标点击。\n"
            )
            sys.exit(4)

    x, y = click_control(auto, toggle)
    print("已点击「系统代理」开关中心 (%d,%d)，等待生效..." % (x, y))
    time.sleep(1.5)

    after = is_port_listening()
    print("操作后 7890 端口: %s" % ("监听(已开)" if after else "仍未监听"))
    if target == "on" and not after:
        sys.stderr.write("警告: 点击后 7890 仍未监听。可能 Mihomo 内核未启动（仅开系统代理不够，需内核 running）。\n")
        sys.exit(5)
    sys.exit(0)


if __name__ == "__main__":
    main()
