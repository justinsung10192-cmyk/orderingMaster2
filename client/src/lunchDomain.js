export function passwordsMatch(password, confirmation) {
  return typeof password === "string" && password.length > 0 && password === confirmation;
}

const AUTH_MODES = new Set(["login", "register", "verifyEmail", "forgot", "reset", "developerLogin", "developerRegister", "developerVerify", "classAdminApply", "classAdminVerify", "merchantLogin", "merchantRegister", "merchantVerify"]);

export function resolveAuthMode(requestedMode) {
  return AUTH_MODES.has(requestedMode) ? requestedMode : "login";
}

export function calculateOrderTotal(item, options, selectedOptionIds) {
  if (!item || !Number.isFinite(Number(item.basePrice))) {
    throw new Error("餐點金額不正確。");
  }

  const selectedIds = Array.isArray(selectedOptionIds) ? selectedOptionIds.map(String) : [];
  if (new Set(selectedIds).size !== selectedIds.length) {
    throw new Error("客製選項不可重複選擇。");
  }

  const optionsById = new Map((options || []).map(option => [String(option.optionId), option]));
  const total = selectedIds.reduce((sum, optionId) => {
    const option = optionsById.get(optionId);
    if (!option || !Number.isFinite(Number(option.priceAdjustment))) {
      throw new Error("客製選項資料不正確。");
    }
    return sum + Number(option.priceAdjustment);
  }, Number(item.basePrice));

  if (total < 0) throw new Error("餐點金額不正確。");
  return total;
}

export function summarizeCart(menuItems, selections) {
  const selectedItems = Array.isArray(selections) ? selections : [];
  if (!selectedItems.length) throw new Error("請至少選擇一項餐點。");
  if (selectedItems.length > 20) throw new Error("單次最多可選擇 20 項餐點。");

  const itemsById = new Map((menuItems || []).map(item => [String(item.itemId), item]));
  const usedItemIds = new Set();
  const items = selectedItems.map(selection => {
    const itemId = String(selection?.itemId || "");
    const quantity = Number(selection?.quantity);
    const item = itemsById.get(itemId);
    if (!item) throw new Error("餐點資料不正確。");
    if (usedItemIds.has(itemId)) throw new Error("相同餐點請直接調整數量。");
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 99) throw new Error("每項餐點數量須為 1–99。 ");
    usedItemIds.add(itemId);
    const optionIds = Array.isArray(selection?.optionIds) ? selection.optionIds.map(String) : [];
    const unitPrice = calculateOrderTotal(item, item.options, optionIds);
    return {
      itemId,
      quantity,
      optionIds,
      itemName: item.name,
      unitPrice,
      lineTotal: unitPrice * quantity,
    };
  });

  return {
    items,
    totalQuantity: items.reduce((sum, item) => sum + item.quantity, 0),
    total: items.reduce((sum, item) => sum + item.lineTotal, 0),
  };
}

export function parseVerificationPayload(rawPayload, now = Date.now()) {
  let payload = rawPayload;
  if (typeof payload === "string") {
    try {
      payload = JSON.parse(payload);
    } catch {
      throw new Error("QR Code 不是有效的驗證資料。");
    }
  }

  if (!payload || typeof payload !== "object" || !payload.uid || !payload.pin || !payload.type || !payload.exp) {
    throw new Error("QR Code 缺少必要的驗證資料。");
  }
  if (!["pickup", "checkout", "topup"].includes(payload.type)) {
    throw new Error("QR Code 的驗證類型不正確。");
  }

  const expiresAt = new Date(payload.exp).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new Error("QR Code 已失效，請學生重新產生。 ");
  }

  return payload;
}

export function getVerificationCountdown(expiresAt, now = Date.now()) {
  const remainingMs = new Date(expiresAt).getTime() - now;
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
    return { expired: true, remainingSeconds: 0 };
  }
  return { expired: false, remainingSeconds: Math.ceil(remainingMs / 1000) };
}

export function reduceScanState(currentState, outcome) {
  if (outcome.ok) {
    return { ...currentState, tab: "scan", scanResult: outcome.result, scanError: "" };
  }
  return { ...currentState, tab: "scan", scanResult: null, scanError: outcome.errorMessage || "掃碼驗證失敗。" };
}

export function refreshVerificationState(currentState, freshVerification) {
  if (!freshVerification?.payload || !freshVerification?.pin || !freshVerification?.expiresAt) {
    throw new Error("新的 QR 憑證資料不完整。");
  }
  return { ...currentState, data: freshVerification, interval: null };
}

export function serializeTemplateChildren(children) {
  return Array.from(children || []).map(child => child.outerHTML).join("");
}
