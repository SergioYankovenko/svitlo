// Refresh updates existing rows. Enrollment is tested separately through createProfile.
export async function refreshSeeded(service,profile) {
  await service.db.saveProfile(profile);
  return service.refresh(profile);
}
