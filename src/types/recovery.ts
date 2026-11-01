
export interface VerificationAnswer {
  question: string;
  answer: string;
}

export interface Claim {
  id: string;
  itemId: string;
  ownerId: string;
  finderId: string;
  answers: VerificationAnswer[];
  status: "PENDING" | "VERIFIED" | "REJECTED";
  reviewNote?: string;
  createdAt: string;
}

export interface Connection {
  id: string;
  claimId: string;
  ownerId: string;
  finderId: string;
  status: "PENDING" | "CONNECTED" | "REJECTED";
  createdAt: string;
}

export interface Recovery {
  id: string;
  claimId: string;
  itemId: string;
  ownerId: string;
  finderId: string;

  pickupDate?: string;
  pickupTime?: string;
  pickupLocation?: string;
  instructions?: string;

  status:
    | "PICKUP_SCHEDULED"
    | "IN_PROGRESS"
    | "RECLAIMED";

  ownerConfirmed: boolean;
  finderConfirmed: boolean;

  createdAt: string;
  updatedAt?: string;
}

export interface RecoveryHistoryEntry {
  id: string;
  recoveryId: string;
  action: string;
  description: string;
  createdAt: string;
}
