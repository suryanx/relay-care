import { ApiError } from "./api";

export function fieldErrors(err: unknown): Record<string, string> {
  if (err instanceof ApiError && err.body.fields) {
    return Object.fromEntries(err.body.fields.map((f) => [f.path, f.message]));
  }
  return {};
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.body.message;
  return "Something went wrong. Please try again.";
}
