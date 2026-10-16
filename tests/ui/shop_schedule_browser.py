"""CODE501 schedule Chromium smoke: real built UI, mocked API fixtures only.
No production backend/PG, Safari hardware, OA or printer tested.
"""
import json

TOKEN="fixture-shop-schedule-bearer"
SHOP="fixture-shop"
CASES=("owner_save","staff_view","patch401","patch403","patch409","patch503","offline")

def run_schedule_case(browser,viewport,case):
    width,height=viewport
    role="staff" if case=="staff_view" else "owner"
    ctx=browser.new_context(viewport={"width":width,"height":height},
          is_mobile=width<600,has_touch=width<600,locale="vi-VN")
    page=ctx.new_page()
    failures=[]
    page.on("pageerror",lambda x:failures.append(str(x)))
    values={"shop_id":SHOP,"version":8,"open_at":"07:00","close_at":"21:30",
            "timezone":"Asia/Ho_Chi_Minh","holiday_dates":["2026-10-20"],
            "manual_lock":False,
            "operational_guard":{"mode":"simulation","printing_enabled":False}}
    count={"get":0,"patch":0,"extra":0,"payload":[]}
    offline={"active":False,"recovered":False}

    def api(route):
        req=route.request
        path=req.url.split("/api/v1/",1)[-1].split("?",1)[0]
        def send(body,status=200):
            route.fulfill(status=status,content_type="application/json",
               body=json.dumps(body,ensure_ascii=False),headers={"Cache-Control":"no-store"})
        def error(code):
            send({"error":{"code":"FIXTURE_"+str(code),"message":"Yêu cầu bị từ chối bởi fixture."}},code)
        if path=="auth/login" and req.method=="POST":
            send({"token":TOKEN,"principal":{"id":"fixture-"+role,"shop_id":SHOP,
                   "role":role,"verified":True}})
        elif req.headers.get("authorization")!="Bearer "+TOKEN:
            error(401)
        elif path=="auth/me" and req.method=="GET":
            send({"principal":{"id":"fixture-"+role,"shop_id":SHOP,
                   "role":role,"verified":True}})
        elif path=="orders" and req.method=="GET":
            send({"orders":[]})
        elif path=="settings/schedule" and req.method=="GET":
            count["get"]+=1
            if offline["active"] and not offline["recovered"]:route.abort("failed")
            else:send(values)
        elif path=="settings/schedule" and req.method=="PATCH":
            count["patch"]+=1
            count["payload"].append(req.post_data_json)
            if case=="offline":
                offline["active"]=True
                route.abort("failed")
            elif case in ("patch401","patch403","patch409","patch503"):
                if case=="patch409":values["version"]=9
                error(int(case[5:]))
            else:
                values["version"]=9;values["open_at"]="08:30"
                send({**values,"changed":True})
        elif req.method!="GET":
            count["extra"]+=1
            error(409)
        else:error(503)

    try:
        page.route("**/api/v1/**",api)
        page.goto("http://127.0.0.1:4173/",wait_until="domcontentloaded")
        login=page.locator('[data-testid="staff-login"]')
        login.wait_for(state="visible",timeout=15000)
        inputs=login.locator("input")
        assert inputs.count()==3
        for i,value in enumerate((SHOP,"fixture-"+role,"fixture-not-secret")):
            inputs.nth(i).fill(value)
        login.locator("button").first.click()
        navigation=page.get_by_role("button",name="Cài đặt & lịch")
        navigation.wait_for(state="attached",timeout=15000)
        if width<600:page.get_by_role("button",name="Mở menu").click()
        navigation.click()
        box=page.locator('[data-testid="schedule-box"]')
        input_open=box.locator('[data-testid="schedule-open-at"]')
        input_open.wait_for(state="visible",timeout=15000)
        assert input_open.input_value()=="07:00"
        assert "không tạm dừng AI" in box.inner_text()
        assert "printing_enabled: false" in box.inner_text()
        assert count["patch"]==0
        if role=="staff":
            assert input_open.is_disabled()
            assert box.locator('[data-testid="schedule-save"]').count()==0
            box.locator('[data-testid="schedule-refresh"]').click()
        else:
            input_open.fill("08:30")
            box.locator('[data-testid="schedule-save"]').click()
            if case=="owner_save":
                saved=box.locator('[data-testid="schedule-status"]')
                saved.wait_for(state="visible",timeout=15000)
                assert "GET xác minh" in saved.inner_text()
                assert "phiên bản 9" in box.inner_text()
                assert input_open.input_value()=="08:30"
                assert box.locator('[data-testid="schedule-error"]').count()==0
            else:
                err=box.locator('[data-testid="schedule-error"]')
                err.wait_for(state="visible",timeout=15000)
                assert box.locator('[data-testid="schedule-save"]').is_disabled()
                if case in ("patch409","patch403","patch503","offline"):
                    if case=="offline":offline["recovered"]=True
                    box.locator('[data-testid="schedule-refresh"]').click()
                    err.wait_for(state="hidden",timeout=15000)
                    # The warning clears before GET completes; do not count
                    # a transient loading-disabled form as a failed recovery.
                    page.wait_for_function("() => { const x=document.querySelector('[data-testid=schedule-open-at]'); return !!x && !x.disabled; }",timeout=15000)
                    assert input_open.is_enabled()
        assert count["extra"]==0
        assert count["patch"]==(0 if role=="staff" else 1)
        for body in count["payload"]:
            assert body["expected_version"]==8
            assert isinstance(body["idempotency_key"],str) and body["idempotency_key"]
            assert body["open_at"]=="08:30"
            assert set(body)=={"expected_version","idempotency_key","open_at"}
        assert not failures, "Chromium JS exception "+repr(failures[:1])
        print("PASS CODE501 SYNTHETIC Chromium "+str(width)+"x"+str(height)+
              " "+case+" GET="+str(count["get"])+" PATCH="+str(count["patch"]),flush=True)
    except Exception:
        # Synthetic fixtures only: useful stack trace with no live credentials.
        import traceback
        print("FAIL CODE501 SYNTHETIC "+str(width)+"x"+str(height)+
              " case="+case+" GET="+str(count["get"])+
              " PATCH="+str(count["patch"]),flush=True)
        traceback.print_exc()
        raise
    finally:
        ctx.close()
