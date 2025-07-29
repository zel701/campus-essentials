from selenium import webdriver
from selenium.webdriver.chrome.service import Service
from webdriver_manager.chrome import ChromeDriverManager
from bs4 import BeautifulSoup

def get_price(url):
    options = webdriver.ChromeOptions()
    options.add_argument('--headless')  # Run in background
    options.add_argument('--disable-gpu')
    options.add_argument('--no-sandbox')

    driver = webdriver.Chrome(service=Service(ChromeDriverManager().install()), options=options)
    driver.get(url)

    html = driver.page_source
    soup = BeautifulSoup(html, 'html.parser')

    price_tag = soup.find('span', {'id': 'pdp-cur-price'})

    driver.quit()

    if price_tag:
        return price_tag.text.strip()
    else:
        return "Price not found"

print(get_price("https://www.barnesandnoble.com/w/the-outsiders-s-e-hinton/1100458329"))
