
import React, { useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import "../../styles/recovery.css";

interface FinderConnectionProps {
  claimId: string;
  isFinder: boolean;
  connectionId?: string;
}

const FinderConnection: React.FC<FinderConnectionProps> = ({
  claimId,
  isFinder,
  connectionId
}) => {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState("NOT_CONNECTED");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const sendRequest = async () => {
    try {
      setLoading(true);
      setError("");
      setMessage("");

      const result = await recoveryService.requestConnection(claimId);

      setStatus(result.status);
      setMessage("Connection request sent successfully.");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to send request."
      );
    } finally {
      setLoading(false);
    }
  };

  const updateRequest = async (
    decision: "CONNECTED" | "REJECTED"
  ) => {
    if (!connectionId) {
      setError("Connection ID is missing.");
      return;
    }

    try {
      setLoading(true);
      setError("");
      setMessage("");

      const result = await recoveryService.updateConnection(
        connectionId,
        decision
      );

      setStatus(result.status);

      setMessage(
        decision === "CONNECTED"
          ? "Connection accepted successfully."
          : "Connection request rejected."
      );
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to update connection."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Connect with Finder</h2>

        <p>
          Establish a connection with the other person to
          coordinate the recovery process.
        </p>

        <div className="status-box">
          <strong>Connection Status:</strong> {status}
        </div>

        {!isFinder && status === "NOT_CONNECTED" && (
          <button onClick={sendRequest} disabled={loading}>
            {loading ? "Sending..." : "Send Connection Request"}
          </button>
        )}

        {isFinder && (
          <div className="button-group">
            <button
              onClick={() => updateRequest("CONNECTED")}
              disabled={loading || !connectionId}
            >
              Accept Request
            </button>

            <button
              className="reject-button"
              onClick={() => updateRequest("REJECTED")}
              disabled={loading || !connectionId}
            >
              Reject Request
            </button>
          </div>
        )}

        {error && <p className="error-message">{error}</p>}
        {message && <p className="success-message">{message}</p>}
      </div>
    </div>
  );
};

export default FinderConnection;
