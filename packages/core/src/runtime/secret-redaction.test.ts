import { describe, expect, it } from "vitest";
import { isCredentialCookieName, setCookieRedactions } from "./secret-redaction.js";

describe("credential cookie names", () => {
  it.each(["session_id", "sid", "auth-token", "XSRF-TOKEN", "refreshToken", "connect.sid", "ASP.NET_SessionId", "XSRFToken", "jwt", "api_key"])(
    "%s qualifies",
    (name) => expect(isCredentialCookieName(name)).toBe(true),
  );

  it.each(["sessionid", "sessid", "PHPSESSID", "JSESSIONID", "csrftoken", "apikey", "django_sessionid", "x-apikey"])(
    "compound %s qualifies",
    (name) => expect(isCredentialCookieName(name)).toBe(true),
  );

  it.each(["monkey", "Access-Mode", "theme", "keyboard_layout", "authority", "consent", "sidebar", "tokenizer", "sessionless", "apikeys"])(
    "%s does not qualify",
    (name) => expect(isCredentialCookieName(name)).toBe(false),
  );

  it("registers an 8-character bare value only under a credential name", () => {
    expect(setCookieRedactions("monkey=abcd1234; Path=/")).toEqual(["monkey=abcd1234"]);
    expect(setCookieRedactions("Access-Mode=readwrite")).toEqual(["Access-Mode=readwrite"]);
    expect(setCookieRedactions("session_id=abcd1234; HttpOnly")).toEqual(["session_id=abcd1234", "abcd1234"]);
    expect(setCookieRedactions("refreshToken=abcd1234")).toEqual(["refreshToken=abcd1234", "abcd1234"]);
    expect(setCookieRedactions("PHPSESSID=abcd1234; Path=/")).toEqual(["PHPSESSID=abcd1234", "abcd1234"]);
    expect(setCookieRedactions("csrftoken=abcd1234")).toEqual(["csrftoken=abcd1234", "abcd1234"]);
    expect(setCookieRedactions("monkey=abcdefghijklmnop")).toEqual(["monkey=abcdefghijklmnop", "abcdefghijklmnop"]);
  });
});
