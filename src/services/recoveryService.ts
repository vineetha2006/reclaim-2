
import type {
  Claim,
  Connection,
  Recovery,
  RecoveryHistoryEntry,
  VerificationAnswer
} from "../types/recovery";

// Flask backend URL
const API_BASE = "http://localhost:5000";

// Common API request function
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const response = await fetch(`${API_BASE}${endpoint}`, {
    ...options,
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...options.headers
    }
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({}));

    throw new Error(
      error.message || error.error || `Request failed: ${response.status}`
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

export const recoveryService = {

  // 1. Submit ownership verification
  createClaim: (data: {
    itemId: string;
    answers: VerificationAnswer[];
  }) =>
    request<Claim>("/api/recovery/claims", {
      method: "POST",
      body: JSON.stringify(data)
    }),

  // 2. Retrieve ownership claims
  getClaims: () =>
    request<Claim[]>("/api/recovery/claims"),

  // 3. Review ownership claim
  reviewClaim: (
    claimId: string,
    decision: "VERIFIED" | "REJECTED",
    reviewNote: string
  ) =>
    request<Claim>(
      `/api/recovery/claims/${encodeURIComponent(claimId)}/review`,
      {
        method: "PATCH",
        body: JSON.stringify({
          decision,
          reviewNote
        })
      }
    ),

  // 4. Send connection request to finder
  requestConnection: (claimId: string) =>
    request<Connection>("/api/recovery/connections", {
      method: "POST",
      body: JSON.stringify({ claimId })
    }),

  // 5. Accept or reject connection request
  updateConnection: (
    connectionId: string,
    status: "CONNECTED" | "REJECTED"
  ) =>
    request<Connection>(
      `/api/recovery/connections/${encodeURIComponent(connectionId)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ status })
      }
    ),

  // 6. Schedule item pickup
  schedulePickup: (
    recoveryId: string,
    data: {
      pickupDate: string;
      pickupTime: string;
      pickupLocation: string;
      instructions: string;
    }
  ) =>
    request<Recovery>(
      `/api/recovery/${encodeURIComponent(recoveryId)}/pickup`,
      {
        method: "PATCH",
        body: JSON.stringify(data)
      }
    ),

  // 7. Confirm successful item handover
  confirmHandover: (
    recoveryId: string,
    role: "owner" | "finder"
  ) =>
    request<Recovery>(
      `/api/recovery/${encodeURIComponent(recoveryId)}/confirm`,
      {
        method: "POST",
        body: JSON.stringify({ role })
      }
    ),

  // 8. Retrieve individual recovery details
  getRecovery: (recoveryId: string) =>
    request<Recovery>(
      `/api/recovery/${encodeURIComponent(recoveryId)}`
    ),

  // 9. Retrieve recovery history
  getHistory: (recoveryId: string) =>
    request<RecoveryHistoryEntry[]>(
      `/api/recovery/${encodeURIComponent(recoveryId)}/history`
    )
};
