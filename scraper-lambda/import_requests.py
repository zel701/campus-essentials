import requests
from bs4 import BeautifulSoup

def get_price(url):
    headers = {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36'
    }

    r = requests.get(url, headers=headers)
    soup = BeautifulSoup(r.text, 'html.parser')

    # Optional: print to check if page is loaded correctly
    # print(soup.prettify())

    price_tag = soup.find('span', {'id': 'pdp-cur-price'})

    if price_tag:
        return price_tag.text.strip()
    else:
        return "Price not found"

# Example usage (use the real product page directly)
print(get_price("https://www.barnesandnoble.com/w/the-outsiders-s-e-hinton/1100458329"))

