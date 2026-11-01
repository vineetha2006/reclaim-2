
import React, { useState } from "react";
import { recoveryService } from "../../services/recoveryService";
import "../../styles/recovery.css";

interface PickupCoordinationProps {
  recoveryId: string;
}

const PickupCoordination: React.FC<PickupCoordinationProps> = ({
  recoveryId
}) => {
  const [pickupDate, setPickupDate] = useState("");
  const [pickupTime, setPickupTime] = useState("");
  const [pickupLocation, setPickupLocation] = useState("");
  const [instructions, setInstructions] = useState("");

  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    setMessage("");
    setError("");

    if (
      !pickupDate ||
      !pickupTime ||
      !pickupLocation.trim()
    ) {
      setError("Please enter all required pickup details.");
      return;
    }

    if (pickupDate < new Date().toLocaleDateString("en-CA")) {
      setError("Please select a future date.");
      return;
    }

    try {
      setLoading(true);

      await recoveryService.schedulePickup(recoveryId, {
        pickupDate,
        pickupTime,
        pickupLocation: pickupLocation.trim(),
        instructions: instructions.trim()
      });

      setMessage("Pickup details saved successfully!");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Unable to schedule pickup."
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="recovery-container">
      <div className="recovery-card">
        <h2>Pickup Coordination</h2>

        <p>Arrange a convenient time and place to collect your item.</p>

        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Pickup Date</label>
            <input
              type="date"
              min={new Date().toLocaleDateString("en-CA")}
              value={pickupDate}
              onChange={e => setPickupDate(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>Pickup Time</label>
            <input
              type="time"
              value={pickupTime}
              onChange={e => setPickupTime(e.target.value)}
              required
            />
          </div>

          <div className="form-group">
            <label>Pickup Location</label>
            <input
              type="text"
              value={pickupLocation}
              onChange={e => setPickupLocation(e.target.value)}
              placeholder="Example: College Library"
              required
            />
          </div>

          <div className="form-group">
            <label>Additional Instructions</label>
            <textarea
              rows={3}
              value={instructions}
              onChange={e => setInstructions(e.target.value)}
              placeholder="Enter additional pickup instructions..."
            />
          </div>

          {error && <p className="error-message">{error}</p>}
          {message && <p className="success-message">{message}</p>}

          <button type="submit" disabled={loading}>
            {loading ? "Saving..." : "Schedule Pickup"}
          </button>
        </form>
      </div>
    </div>
  );
};

export default PickupCoordination;
