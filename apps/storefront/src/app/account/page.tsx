import { ChangePasswordForm, ProfileForm } from "@/components/account/details-forms";
import { ResendVerification } from "@/components/auth/recovery-forms";
import { getSessionUser } from "@/lib/api-server";

export default async function AccountDetailsPage() {
  // The layout has already handled a missing session; this renders in parallel.
  const user = await getSessionUser();
  if (!user) return null;

  return (
    <div className="flex flex-col gap-10">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">
          {user.first_name ? `Hello, ${user.first_name}` : "Your details"}
        </h1>
        <p className="text-text-secondary mt-1">{user.email}</p>
      </header>

      {!user.email_verified && (
        <section
          aria-labelledby="verify-heading"
          className="border-warning/40 bg-warning/10 flex flex-col gap-3 rounded-lg border p-4"
        >
          <h2 id="verify-heading" className="font-medium">
            Confirm your email address
          </h2>
          <p className="text-text-secondary text-sm">
            We sent a link to {user.email}. Confirming it lets us reach you about your orders.
          </p>
          <ResendVerification defaultEmail={user.email} />
        </section>
      )}

      <section aria-labelledby="profile-heading" className="flex flex-col gap-5">
        <h2 id="profile-heading" className="text-lg font-medium">
          Profile
        </h2>
        <ProfileForm user={user} />
      </section>

      <section aria-labelledby="password-heading" className="flex flex-col gap-5">
        <h2 id="password-heading" className="text-lg font-medium">
          Password
        </h2>
        <ChangePasswordForm email={user.email} />
      </section>
    </div>
  );
}
