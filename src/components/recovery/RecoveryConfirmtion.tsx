
import React, { useEffect, useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import type { Recovery } from "../../types/recovery";
import "../../styles/recovery.css";

interface RecoveryConfirmationProps {
  recoveryId: string;
  role: "owner" | "finder";
}

const RecoveryConfirmation: React.FC<RecoveryConfirmationProps> = ({
  recoveryId,
  role
}) => {
  const [recovery, setRecovery] = useState<Recovery | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");

  const loadRecovery = async () => {
    try {
      const data = await recoveryService.getRecovery(recoveryId);
      setRecovery(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to load recovery."
      );
    }
  };

  useEffect(() => {
    loadRecovery();
  }, [recoveryId]);

  const confirmReturn = async () => {
    try {
      setLoading(true);
      setError("");
      setMessage("");

      await recoveryService.confirmHandover(recoveryId, role);

      setMessage("Your handover confirmation has been recorded.");

      await loadRecovery();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to confirm handover."
      );
    } finally {
      setLoading(false);
    }
  };

  if (!recovery) {
    return (
      <div className="recovery-container">
        <div className="recovery-card">
          {error || "Loading recovery details..."}
        </div>
      </div>
    );
  }

  const myConfirmation =
    role === "owner"
      ? recovery.ownerConfirmed
      : recovery.finderConfirmed;

  const bothConfirmed =
    recovery.ownerConfirmed && recovery.finderConfirmed;

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Recovery Confirmation</h2>

        <p>Confirm that the physical item handover has taken place.</p>

        <div className="status-box">
          <p>
            <strong>Owner:</strong>{" "}
            {recovery.ownerConfirmed ? "Confirmed" : "Pending"}
          </p>

          <p>
            <strong>Finder:</strong>{" "}
            {recovery.finderConfirmed ? "Confirmed" : "Pending"}
          </p>
        </div>

        {bothConfirmed ? (
          <div className="success-message">
            <h3>Item Successfully Reclaimed!</h3>
            <p>Both parties have confirmed the item handover.</p>
          </div>
        ) : (
          <>
            <p>
              Your confirmation:
              <strong> {myConfirmation ? "Completed" : "Pending"}</strong>
            </p>

            <button
              onClick={confirmReturn}
              disabled={loading || myConfirmation}
            >
              {loading
                ? "Confirming..."
                : myConfirmation
                  ? "Already Confirmed"
                  : "Confirm Item Received / Handed Over"}
            </button>
          </>
        )}

        {error && <p className="error-message">{error}</p>}
        {message && <p className="success-message">{message}</p>}
      </div>
    </div>
  );
};

export default RecoveryConfirmation;
