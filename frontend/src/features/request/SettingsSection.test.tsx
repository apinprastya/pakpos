import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { DEFAULT_SETTINGS, emptyRequest, type Request } from "@/lib/model";
import { useSettingsStore } from "@/stores/settings";
import { SettingsSection } from "./SettingsSection";
import {
  appValueLabel,
  formatSeconds,
  overrideCount,
  parseMaxRedirects,
  parseTimeout,
  withSetting,
} from "./requestSettings";

const latest: { current: Request } = { current: emptyRequest() };

function Host({ initial }: { initial: Partial<Request> }) {
  const [req, setReq] = useState<Request>({ ...emptyRequest(), ...initial });
  return (
    <>
      <SettingsSection
        request={req}
        onChange={(u) =>
          setReq((r) => {
            latest.current = u(r);
            return latest.current;
          })
        }
      />
      <button type="button" onClick={() => setReq({ ...emptyRequest(), settings: { timeoutMs: 4500 } })}>
        Set from outside
      </button>
    </>
  );
}

function renderSection(initial: Partial<Request> = {}) {
  const user = userEvent.setup();
  render(<Host initial={initial} />);
  return user;
}

async function choose(user: ReturnType<typeof userEvent.setup>, field: string, option: string | RegExp) {
  await user.click(screen.getByRole("combobox", { name: field }));
  await user.click(screen.getByRole("option", { name: option }));
}

describe("request settings helpers", () => {
  it("parses and formats timeouts in seconds", () => {
    expect(parseTimeout("2.5")).toBe(2500);
    expect(parseTimeout(" 0 ")).toBe(0);
    expect(parseTimeout("600")).toBe(600_000);
    expect(parseTimeout("600.001")).toBeNull();
    expect(parseTimeout("1.2345")).toBeNull();
    expect(parseTimeout("-1")).toBeNull();
    expect(parseTimeout("soon")).toBeNull();
    expect(formatSeconds(2500)).toBe("2.5");
    expect(formatSeconds(30_000)).toBe("30");
  });

  it("parses redirect limits", () => {
    expect(parseMaxRedirects("3")).toBe(3);
    expect(parseMaxRedirects("0")).toBeNull();
    expect(parseMaxRedirects("51")).toBeNull();
    expect(parseMaxRedirects("2.5")).toBeNull();
  });

  it("sets and clears single settings and counts overrides", () => {
    const s = withSetting({}, "verifyTls", false);
    expect(s).toEqual({ verifyTls: false });
    expect(overrideCount(s)).toBe(1);
    expect(withSetting(s, "verifyTls", undefined)).toEqual({});
    expect(overrideCount({ timeoutMs: 0, followRedirects: false })).toBe(2);
  });

  it("describes the app setting each field falls back to", () => {
    const app = {
      ...DEFAULT_SETTINGS,
      timeoutMs: 0,
      followRedirects: false,
      verifyTls: true,
      maxRedirects: 7,
    };
    expect(appValueLabel("timeoutMs", app)).toBe("no limit");
    expect(appValueLabel("timeoutMs", DEFAULT_SETTINGS)).toBe("30 s");
    expect(appValueLabel("followRedirects", app)).toBe("off");
    expect(appValueLabel("followRedirects", DEFAULT_SETTINGS)).toBe("on");
    expect(appValueLabel("maxRedirects", app)).toBe("7");
    expect(appValueLabel("verifyTls", app)).toBe("on");
    expect(appValueLabel("verifyTls", { ...app, verifyTls: false })).toBe("off");
  });
});

describe("SettingsSection", () => {
  beforeEach(() => {
    latest.current = emptyRequest();
  });

  it("uses app settings by default and names them", () => {
    renderSection();
    expect(screen.getByRole("combobox", { name: "Timeout" })).toHaveTextContent("Use app setting (30 s)");
    expect(screen.getByRole("combobox", { name: "Follow redirects" })).toHaveTextContent(
      "Use app setting (on)",
    );
    expect(screen.getByRole("combobox", { name: "Verify TLS certificates" })).toHaveTextContent(
      "Use app setting (on)",
    );
    expect(screen.queryByRole("button", { name: "Use app settings for all" })).not.toBeInTheDocument();
  });

  it("overrides the timeout, validates it and goes back to the app setting", async () => {
    const user = renderSection();
    await choose(user, "Timeout", "Custom");
    const input = screen.getByRole("textbox", { name: "Timeout for this request" });
    expect(input).toHaveValue("30");
    expect(latest.current.settings).toEqual({ timeoutMs: 30_000 });

    await user.clear(input);
    await user.type(input, "2.5");
    expect(latest.current.settings).toEqual({ timeoutMs: 2500 });

    await user.clear(input);
    await user.type(input, "abc");
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByText("Enter seconds from 0 to 600.")).toBeInTheDocument();
    expect(latest.current.settings).toEqual({ timeoutMs: 2500 });

    await choose(user, "Timeout", /^Use app setting/);
    expect(latest.current.settings).toEqual({});
    expect(screen.queryByRole("textbox", { name: "Timeout for this request" })).not.toBeInTheDocument();
  });

  it("overrides redirects and TLS verification, with a warning when off", async () => {
    const user = renderSection();
    await choose(user, "Follow redirects", "Off");
    expect(latest.current.settings).toEqual({ followRedirects: false });
    expect(screen.getByText("Not used: this request doesn't follow redirects.")).toBeInTheDocument();
    await choose(user, "Maximum redirects", "Custom");
    const max = screen.getByRole("textbox", { name: "Maximum redirects for this request" });
    await user.clear(max);
    await user.type(max, "99");
    expect(screen.getByText("Enter a number from 1 to 50.")).toBeInTheDocument();
    await user.clear(max);
    await user.type(max, "3");
    expect(latest.current.settings).toMatchObject({ maxRedirects: 3 });

    await choose(user, "Verify TLS certificates", "Off");
    expect(latest.current.settings).toMatchObject({ verifyTls: false });
    expect(screen.getByRole("note")).toHaveTextContent("accepts any certificate");
    await choose(user, "Verify TLS certificates", "On");
    expect(latest.current.settings).toMatchObject({ verifyTls: true });
    expect(screen.queryByRole("note")).not.toBeInTheDocument();
    await choose(user, "Follow redirects", /^Use app setting/);
    expect(latest.current.settings).not.toHaveProperty("followRedirects");

    await user.click(screen.getByRole("button", { name: "Use app settings for all" }));
    expect(latest.current.settings).toEqual({});
  });

  it("follows changes made elsewhere, such as a cURL import", async () => {
    const user = renderSection({ settings: { timeoutMs: 1000 } });
    expect(screen.getByRole("textbox", { name: "Timeout for this request" })).toHaveValue("1");
    await user.click(screen.getByRole("button", { name: "Set from outside" }));
    expect(screen.getByRole("textbox", { name: "Timeout for this request" })).toHaveValue("4.5");
  });

  it("shows the app's current values", () => {
    useSettingsStore.setState({ settings: { ...DEFAULT_SETTINGS, timeoutMs: 0, verifyTls: false } });
    renderSection();
    expect(screen.getByRole("combobox", { name: "Timeout" })).toHaveTextContent("no limit");
    expect(
      within(screen.getByRole("region", { name: "Request settings" })).getByRole("note"),
    ).toBeInTheDocument();
  });
});
