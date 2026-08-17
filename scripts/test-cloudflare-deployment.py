#!/usr/bin/env python3
import json
import os

from playwright.sync_api import TimeoutError as PlaywrightTimeoutError
from playwright.sync_api import sync_playwright


URL = os.environ.get(
    "DEPLOYMENT_URL",
    "https://crypto-funding-arbitrage.pages.dev/",
)
PROXY_SERVER = os.environ.get("PLAYWRIGHT_PROXY")
BROWSER_EXECUTABLE = os.environ.get(
    "PLAYWRIGHT_BROWSER_EXECUTABLE",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
)
SCREENSHOT_PATH = os.environ.get(
    "DEPLOYMENT_SCREENSHOT",
    "/tmp/crypto-funding-arbitrage-deployment.png",
)


def compact(text):
    return " ".join((text or "").split())


events = []


def record(kind, message):
    if len(events) < 50:
        events.append({"kind": kind, "message": compact(str(message))[:500]})


with sync_playwright() as playwright:
    launch_options = {"headless": True}
    if PROXY_SERVER:
        launch_options["proxy"] = {"server": PROXY_SERVER}
    if os.path.exists(BROWSER_EXECUTABLE):
        launch_options["executable_path"] = BROWSER_EXECUTABLE

    browser = playwright.chromium.launch(**launch_options)
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on(
        "console",
        lambda message: record(f"console:{message.type}", message.text)
        if message.type in {"error", "warning"}
        else None,
    )
    page.on("pageerror", lambda error: record("pageerror", error))
    page.on(
        "requestfailed",
        lambda request: record(
            "requestfailed",
            f"{request.resource_type} {request.url} {request.failure}",
        ),
    )

    reached_network_idle = True
    try:
        page.goto(URL, wait_until="networkidle", timeout=120_000)
    except PlaywrightTimeoutError:
        reached_network_idle = False
        record("navigation", "networkidle timeout")

    page.wait_for_selector("#arbitrageBody tr", state="attached", timeout=30_000)
    state = page.evaluate(
        """
        () => ({
          title: document.title,
          url: location.href,
          readyState: document.readyState,
          refreshStatus: document.querySelector("#refreshStatus")?.textContent,
          lastUpdated: document.querySelector("#lastUpdated")?.textContent,
          symbols: document.querySelector("#statSymbols")?.textContent,
          opportunities: document.querySelector("#statOpportunities")?.textContent,
          maxSpread: document.querySelector("#statMaxSpread")?.textContent,
          maxApr: document.querySelector("#statMaxApr")?.textContent,
          arbitrageRows: document.querySelectorAll("#arbitrageBody tr").length,
          allRateRows: document.querySelectorAll("#allRatesBody tr").length,
          exchangeStatus: document.querySelector("#exchangeStatus")?.textContent,
          firstRows: Array.from(document.querySelectorAll("#arbitrageBody tr"))
            .slice(0, 3)
            .map((row) => row.textContent),
        })
        """
    )
    state = {
        key: [compact(item) for item in value]
        if isinstance(value, list)
        else compact(value)
        if isinstance(value, str)
        else value
        for key, value in state.items()
    }
    page.screenshot(path=SCREENSHOT_PATH, full_page=True)
    browser.close()

result = {
    "networkIdle": reached_network_idle,
    "state": state,
    "events": events,
    "screenshot": SCREENSHOT_PATH,
}
print(json.dumps(result, ensure_ascii=False, indent=2))

if state["title"] != "资金费率套利监控 Dashboard":
    raise SystemExit("Unexpected page title")
if state["arbitrageRows"] < 1:
    raise SystemExit("No arbitrage rows rendered")
