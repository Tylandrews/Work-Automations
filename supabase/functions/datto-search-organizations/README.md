# Datto Search Organizations Edge Function (Deprecated)

This Edge Function was replaced by the Autotask PSA implementation. Use `autotask-search-companies-v3` instead.

## Setup

### 1. Set Supabase Secrets

Set the following secrets in your Supabase project:

```bash
# Via Supabase CLI
supabase secrets set DATTO_API_KEY=your-api-key-here
supabase secrets set DATTO_BASE_URL=https://rmm.datto.com
supabase secrets set DATTO_TENANT_ID=optional-tenant-id  # Only if required
```

Or via Supabase Dashboard:
- Go to **Settings → Edge Functions → Secrets**
- Add each secret key-value pair

### 2. Deploy the Function

```bash
supabase functions deploy datto-search-organizations
```

## API Usage

The function accepts GET requests with query parameters:

- `q` (required): Search query string (minimum 2 characters)
- `limit` (optional): Maximum number of results (default: 20, max: 50)

### Example Request

```
GET /functions/v1/datto-search-organizations?q=acme&limit=20
Authorization: Bearer <supabase-jwt-token>
```

### Example Response

```json
{
  "organizations": [
    {
      "id": "123",
      "name": "Acme Corporation"
    }
  ]
}
```

## Security

- API key is stored in Supabase secrets (server-side only)
- All requests require Supabase JWT authentication
- Rate limiting is enforced (50 requests per minute per function instance)
- Error messages never expose sensitive information
- API key never appears in client code or network traffic

## Notes

- The exact Datto RMM API endpoint may need adjustment based on your Datto API documentation
- Current implementation assumes endpoint: `/api/v2/organizations`
- Adjust the `searchDattoOrganizations` function if your Datto API uses different endpoints or authentication
